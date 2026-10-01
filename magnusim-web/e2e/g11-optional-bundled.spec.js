import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_GEOMETRY_PROJECT, prepareE2eProjectsRoot } from './prepare-projects.js';

// G11, an optional bundled plugin that ships off (manifest default_enabled = false),
// as the user meets it: existing projects look unchanged (no STUDIES, no Workspaces
// menu, nothing served), a link into its workspace says it is off, Settings lists it
// Off with a note, Enable brings its launchers at once, the choice survives a units
// save and a registry reload, and Disable takes it away again with its study kept.
// Then a bundled plugin whose manifest does not parse: its study names the plugin it
// needs, and Settings lists it as bundled, by its name, with the parser's line and column.
// A second app server whose bundled folder holds Incompressible Flow, the opt-demo
// fixture (python/tests/fixtures/optional-plugins) and two broken plugins written here.
const PROJECT = 'sample-project-steady-state-e2e';
const KEY = 'opt-demo';
// Bundled plugins whose manifest.toml does not parse, each with a study in the project
// with no geometry (saved while the plugin still worked).
const BROKEN = 'broken-demo';
const NAMELESS = 'broken-noname';

function stage(t0, msg) {
  console.log(`[g11 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

// A plugin folder whose manifest is these lines (line N of the file is lines[N - 1]).
function writePlugin(folder, lines) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'manifest.toml'), lines.join('\n') + '\n');
  writeFileSync(join(folder, 'plugin.py'), 'def register(hub):\n    return None\n');
}

// A study record as the plugin's SDK saves it: plugins/<key>/studies/<id>/study.json in the project.
function writeStudy(projects, pid, plugin, rec) {
  const folder = join(projects, pid, 'plugins', plugin, 'studies', rec.id);
  mkdirSync(folder, { recursive: true });
  const at = '2026-10-01T00:00:00Z';
  const full = { kind: 'part', schema_version: 1, rev: 1, plugin, plugin_version: '1.0.0', created_at: at, updated_at: at, ...rec };
  writeFileSync(join(folder, 'study.json'), JSON.stringify(full, null, 2));
}

async function waitUp(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

test('gate:g11-optional-bundled a plugin that ships off is listed, turned on, remembered and turned off', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const port = String(Number(process.env.MAGNUSIM_E2E_PORT || 8083) + 15);
  const base = `http://127.0.0.1:${port}`;
  const tmp = mkdtempSync(join(tmpdir(), 'magnusim-g11-'));
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  cpSync(resolve('python/tests/fixtures/optional-plugins/opt-demo'), join(bundled, KEY), { recursive: true });
  // Line 4 has no "=" (the parser stops at column 13); the name on line 2 still reads.
  writePlugin(join(bundled, BROKEN), [
    `key = "${BROKEN}"`,
    'name = "Broken demo"',
    'version = "1.0.0"',
    'api_version "1.2"',
    'license = "GPL-3.0-or-later"',
    'required = false',
    '',
    '[[study_kinds]]',
    'key = "part"',
    'title = "Part"',
    'icon = "M5 19V5h14v14z"',
  ]);
  // The name is not quoted: the parser stops on line 2, column 8, and there is no name to show.
  writePlugin(join(bundled, NAMELESS), [`key = "${NAMELESS}"`, 'name = Nameless demo', 'version = "1.0.0"', 'api_version = "1.2"']);
  // Saved while the plugin had another name: its study keeps that one, not the manifest's now.
  writeStudy(projects, NO_GEOMETRY_PROJECT, BROKEN, { id: 'st-broken-1', title: 'Bracket', plugin_name: 'Older demo' });
  writeStudy(projects, NO_GEOMETRY_PROJECT, NAMELESS, { id: 'st-nameless-1', title: 'Housing', plugin_name: 'Nameless demo' });
  const plugins = join(tmp, 'plugins');
  mkdirSync(plugins);
  const prefs = join(tmp, 'prefs.json');
  writeFileSync(prefs, JSON.stringify({ wizard_completed: true, units: 'Metric', port: Number(port) }));
  const lists = () => {
    const p = JSON.parse(readFileSync(prefs, 'utf8')).plugins || {};
    return { disabled: p.disabled || [], enabled: p.enabled || [] };
  };
  const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--strictPort'], {
    env: {
      ...process.env,
      MAGNUSIM_PROJECTS_ROOT: projects,
      MAGNUSIM_LOCAL_JSON: prefs,
      MAGNUSIM_PORT: port,
      MAGNUSIM_BOUND_PORT: port,
      MAGNUSIM_BUNDLED_DIR: bundled,
      MAGNUSIM_PLUGINS_DIR: plugins,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const listed = async () => {
    const j = await (await request.get(`${base}/api/plugins`)).json();
    return (j.plugins || []).find((p) => p.key === KEY) || null;
  };
  try {
    expect(await waitUp(`${base}/api/registry`, 120_000), `second server did not start:\n${log.slice(-2000)}`).toBe(true);

    // Off: listed (so it can be turned on), nothing of it runs or shows.
    expect(await listed()).toMatchObject({ status: 'disabled', default_enabled: false, tier: 'bundled', name: 'Optional demo' });
    expect((await request.get(`${base}/plugins/${KEY}/workspace/index.html`)).status()).toBe(404);
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await expect(page.locator('#plugin-studies-section')).toBeHidden();
    await expect(page.locator('#btn-workspaces')).toHaveCount(0);
    // A link into its workspace says it is off, and where to turn it on.
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/bench/st-00000000`);
    const card = page.locator('#workspace-overlay [data-ws-error]');
    await expect(card.locator('h2')).toHaveText('Optional demo is off.', { timeout: 60_000 });
    await expect(card.locator('[data-ws-settings]')).toHaveText('Open Settings → Plugins');
    await page.goto(`${base}/#/p/${PROJECT}`);
    await expect(page.locator('#workspace-overlay')).toBeHidden();
    stage(t0, 'ships off: listed, nothing shown or served');

    // Settings: Off with a note; Enable brings its launchers at once.
    await page.locator('#wb-prefs').click();
    const wizard = page.locator('#setup-wizard');
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    const row = wizard.locator(`[data-plugin-key="${KEY}"]`);
    await expect(row).toHaveAttribute('data-plugin-status', 'disabled');
    await expect(row).toHaveAttribute('data-plugin-default-off', '1');
    await expect(row.locator('.wiz-plugin-status')).toHaveText('Off');
    await expect(row.locator('[data-plugin-optional-hint]')).toHaveText('Ships with Magnusim and stays off until you turn it on.');
    await row.locator(`[data-plugin-toggle="${KEY}"]`).click();
    await expect(row).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 30_000 });
    await expect(row.locator('[data-plugin-optional-hint]')).toHaveCount(0);
    await page.locator('#wiz-next').click();
    await expect(wizard).toBeHidden();
    await expect(page.locator('#plugin-studies-section')).toBeVisible();
    await expect(page.locator(`#plugin-studies-section [data-plugin-study-new="${KEY}:opt_case"]`)).toHaveText('+ New Optional case');
    await expect(page.locator('#btn-workspaces')).toBeVisible();
    expect(lists()).toEqual({ disabled: [], enabled: [KEY] });
    stage(t0, 'turned on in Settings');

    // Its workspace opens from the Workspaces menu.
    await page.locator('#btn-workspaces').click();
    await page.locator(`[data-ws-new="${KEY}:opt_case"]`).click();
    await page.locator('#pm-input').fill('First part');
    await page.locator('#pm-confirm').click();
    await expect(page.frameLocator('#workspace-frame').locator('#opt-status')).toHaveText('Optional demo connected: First part');
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#workspace-overlay')).toBeHidden();
    stage(t0, 'its workspace opens');

    // Remembered: a units save (Node writes prefs) and a registry reload keep it on.
    expect((await request.post(`${base}/api/prefs`, { data: { units: 'Imperial' } })).ok()).toBe(true);
    await request.post(`${base}/api/worker`, { data: { method: 'registry.reload', params: {} } });
    expect(await listed()).toMatchObject({ status: 'enabled' });
    expect(lists()).toEqual({ disabled: [], enabled: [KEY] });
    await request.post(`${base}/api/prefs`, { data: { units: 'Metric' } });
    stage(t0, 'kept on after a units save and a reload');

    // Turned off: launchers go, the study stays greyed with the plugin's name.
    await page.locator('#wb-prefs').click();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    await row.locator(`[data-plugin-toggle="${KEY}"]`).click();
    await expect(row).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 });
    await page.locator('#wiz-next').click();
    await expect(wizard).toBeHidden();
    await expect(page.locator('#btn-workspaces')).toHaveCount(0);
    const study = page.locator('#plugin-studies-section [data-plugin-study]', { hasText: 'First part' });
    await expect(study).toHaveAttribute('data-unavailable', '1');
    await expect(study).toContainText('Requires the Optional demo plugin');
    await expect(page.locator(`#plugin-studies-section [data-plugin-study-new="${KEY}:opt_case"]`)).toHaveCount(0);
    expect(lists()).toEqual({ disabled: [KEY], enabled: [] });
    expect((await request.get(`${base}/plugins/${KEY}/workspace/index.html`)).status()).toBe(404);
    stage(t0, 'turned off: launchers gone, study kept greyed');

    // gate:g11-broken-manifest: a study of a plugin whose manifest does not parse says which
    // plugin it needs by the name the study saved (as for a plugin that is off), never by
    // its folder, nor by the name a line of the broken manifest still gives ("Broken demo").
    await page.goto(`${base}/#/p/${NO_GEOMETRY_PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, NO_GEOMETRY_PROJECT, { timeout: 60_000 });
    const broken = page.locator('#plugin-studies-section [data-plugin-study="st-broken-1"]');
    await expect(broken).toHaveAttribute('data-unavailable', '1');
    await expect(broken.locator('[data-plugin-study-reason]')).toHaveText('Requires the Older demo plugin. Open Settings → Plugins');
    const nameless = page.locator('#plugin-studies-section [data-plugin-study="st-nameless-1"]');
    await expect(nameless).toHaveAttribute('data-unavailable', '1');
    await expect(nameless.locator('[data-plugin-study-reason]')).toHaveText('Requires the Nameless demo plugin. Open Settings → Plugins');
    // Its link opens Settings → Plugins. The row is bundled (where its folder is), named
    // as its manifest names it when a line still gives the name (else by its folder), and
    // says what the TOML parser found and where: the file's name, never its path.
    await broken.getByRole('button', { name: 'Open Settings → Plugins' }).click();
    await expect(wizard).toBeVisible();
    await expect(wizard.locator('[data-wiz-step="5"]')).toBeVisible();
    const brokenRow = wizard.locator(`[data-plugin-key="${BROKEN}"]`);
    await expect(brokenRow).toHaveAttribute('data-plugin-status', 'error');
    await expect(brokenRow).toHaveAttribute('data-plugin-source', 'bundled');
    await expect(brokenRow.locator('strong')).toHaveText(/^Broken demo v\S+ · bundled$/);
    await expect(brokenRow.locator('.wiz-plugin-status')).toHaveText('Failed to load');
    await expect(brokenRow.locator('.wiz-plugin-error')).toHaveText(
      /^manifest\.toml is not valid TOML \(line 4, column 13\): Expected '=' after a key/,
    );
    const namelessRow = wizard.locator(`[data-plugin-key="${NAMELESS}"]`);
    await expect(namelessRow).toHaveAttribute('data-plugin-source', 'bundled');
    await expect(namelessRow.locator('strong')).toHaveText(new RegExp(`^${NAMELESS} v\\S+ · bundled$`));
    await expect(namelessRow.locator('.wiz-plugin-error')).toHaveText(/^manifest\.toml is not valid TOML \(line 2, column 8\): Invalid value/);
    for (const r of [brokenRow, namelessRow]) await expect(r.locator('.wiz-plugin-error')).not.toContainText('magnusim-g11-');
    await wizard.locator('#wiz-skip').click();
    await expect(wizard).toBeHidden();
    stage(t0, 'broken manifests: bundled, by name, parser line and column; their studies name the plugin');
  } finally {
    killTree(server);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* a file may still be held for a moment */
    }
  }
});
