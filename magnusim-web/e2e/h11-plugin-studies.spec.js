import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_GEOMETRY_PROJECT } from './prepare-projects.js';

// H11: project-level studies a plugin owns (the study-demo fixture plugin),
// as the user meets them in the tree: create, rename, reload, delete in a
// project with no geometry; a rename from a stale tab is refused and says so;
// a study whose plugin is off stays, greyed, byte for byte, and comes back.
const PROJECTS_ROOT = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
const EMPTY = NO_GEOMETRY_PROJECT;
const FIXTURE = 'sample-project-steady-state-e2e';
const PLUGIN = 'study-demo';

async function getJson(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

async function openProject(page, pid) {
  await page.goto(`/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

const section = (page) => page.locator('#plugin-studies-section');
const studyRow = (page, title) => section(page).locator('[data-plugin-study]', { has: page.locator('.tl', { hasText: title }) });

async function promptAnswer(page, text) {
  await expect(page.locator('#modal-prompt')).toBeVisible();
  await page.locator('#pm-input').fill(text);
  await page.locator('#pm-confirm').click();
  await expect(page.locator('#modal-prompt')).toBeHidden();
}

function folderHash(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        h.update(p.slice(dir.length));
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

async function createViaApi(request, pid, title) {
  const r = await request.post('/api/plugin-studies/create', { data: { project_id: pid, plugin: PLUGIN, kind: 'demo_analysis', title } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return j.study;
}

test('gate:h11-study-tree-empty-project create, rename, reload and delete a plugin study with no geometry @plugins', async ({ page }) => {
  test.setTimeout(120_000);
  await openProject(page, EMPTY);
  // The empty stage hides the (geometry-bound) simulations; the plugin's studies stay.
  await expect(page.locator('#simulations-section')).toBeHidden();
  await expect(section(page)).toBeVisible();
  await expect(section(page)).toContainText('STUDIES (0)');
  await expect(section(page)).toContainText('No study yet');

  await section(page).getByRole('button', { name: '+ New Demo analysis' }).click();
  await promptAnswer(page, 'Wing A');
  await expect(studyRow(page, 'Wing A')).toBeVisible();
  await expect(section(page)).toContainText('STUDIES (1)');
  await expect(studyRow(page, 'Wing A')).toHaveAttribute('data-scope-key', new RegExp(`^p:${EMPTY}/plugin:${PLUGIN}/study:st-`));

  await studyRow(page, 'Wing A').getByRole('button', { name: 'Rename Wing A' }).click();
  await promptAnswer(page, 'Wing B');
  await expect(studyRow(page, 'Wing B')).toBeVisible();
  await expect(section(page)).not.toContainText('Wing A');

  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, EMPTY, { timeout: 60_000 });
  await expect(studyRow(page, 'Wing B')).toBeVisible();
  await expect(section(page)).toContainText('STUDIES (1)');

  await studyRow(page, 'Wing B').getByRole('button', { name: 'Delete Wing B' }).click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-copy')).toContainText('"Wing B" and everything saved with it will be deleted.');
  await page.locator('#cf-confirm').click();
  await expect(section(page)).toContainText('No study yet');
  await expect(section(page)).toContainText('STUDIES (0)');
  expect(existsSync(join(PROJECTS_ROOT, EMPTY, 'plugins', PLUGIN, 'studies')) && readdirSync(join(PROJECTS_ROOT, EMPTY, 'plugins', PLUGIN, 'studies')).length).toBeFalsy();
});

test('gate:h11-stale-rev a rename from a stale tab is refused and says why @plugins', async ({ page, request }) => {
  test.setTimeout(120_000);
  const st = await createViaApi(request, EMPTY, 'Stale 1');
  await openProject(page, EMPTY);
  await expect(studyRow(page, 'Stale 1')).toBeVisible();
  // Another tab renames it meanwhile (rev 1 -> 2); this tree still shows rev 1.
  const other = await request.post('/api/plugin-studies/rename', {
    data: { project_id: EMPTY, plugin: PLUGIN, study_id: st.id, title: 'Renamed elsewhere', rev: 1 },
  });
  expect(other.ok()).toBe(true);
  const direct = await request.post('/api/plugin-studies/rename', {
    data: { project_id: EMPTY, plugin: PLUGIN, study_id: st.id, title: 'Late', rev: 1 },
  });
  expect(direct.status()).toBe(409);

  await studyRow(page, 'Stale 1').getByRole('button', { name: 'Rename Stale 1' }).click();
  await promptAnswer(page, 'Mine');
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Rename failed');
  await expect(page.locator('#cf-copy')).toHaveText('This study changed in another tab. Reload to continue.');
  await page.locator('#cf-confirm').click();
  // The tree reloads with the other tab's name; nothing was overwritten.
  await expect(studyRow(page, 'Renamed elsewhere')).toBeVisible();
  await expect(section(page)).not.toContainText('Mine');
  await request.post('/api/plugin-studies/delete', { data: { project_id: EMPTY, plugin: PLUGIN, study_id: st.id } });
});

test('gate:h11-disabled-study-preserved a study whose plugin is off stays greyed and unchanged @plugins', async ({ page, request }) => {
  test.setTimeout(180_000);
  const st = await createViaApi(request, FIXTURE, 'Kept study');
  const folder = join(PROJECTS_ROOT, FIXTURE, 'plugins', PLUGIN);
  const before = folderHash(folder);
  try {
    const off = await request.post(`/api/plugins/${PLUGIN}/disable`);
    expect(off.ok(), await off.text()).toBe(true);
    await openProject(page, FIXTURE);
    const row = studyRow(page, 'Kept study');
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/is-unavailable/);
    await expect(row).toContainText('Requires the Study demo plugin');
    await expect(row.getByRole('button', { name: 'Rename Kept study' })).toHaveCount(0);
    await expect(section(page).getByRole('button', { name: /\+ New/ })).toHaveCount(0);
    // The core's own tree is untouched beside it.
    await expect(page.locator('#simulations-section')).toBeVisible();
    await row.getByRole('button', { name: 'Open Settings → Plugins' }).click();
    await expect(page.locator('#setup-wizard')).toBeVisible();
    await expect(page.locator('#setup-wizard [data-wiz-step="5"]')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(folderHash(folder)).toBe(before);
    const listed = await getJson(request, `/api/plugin-studies?project_id=${FIXTURE}`);
    expect(listed.studies.find((s) => s.id === st.id)).toMatchObject({ available: false, title: 'Kept study' });
  } finally {
    const on = await request.post(`/api/plugins/${PLUGIN}/enable`);
    expect(on.ok(), await on.text()).toBe(true);
  }
  // Same project URL: reload the page so the tree is read again.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 60_000 });
  const back = studyRow(page, 'Kept study');
  await expect(back).toBeVisible();
  await expect(back).not.toHaveClass(/is-unavailable/);
  await expect(back.getByRole('button', { name: 'Rename Kept study' })).toBeVisible();
  expect(folderHash(folder)).toBe(before);
  await request.post('/api/plugin-studies/delete', { data: { project_id: FIXTURE, plugin: PLUGIN, study_id: st.id } });
});
