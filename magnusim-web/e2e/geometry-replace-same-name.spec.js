import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Daniel: "I uploaded a part, made changes in my solidworks, deleted the part from magnusim,
// and uploaded the new part ... it worked initially, but when i clicked create simulation
// that was when it changed the part to the old part."
// The same steps through the UI: a part with a study, removed, then a different part from a
// file of the SAME name (it gets the same folder, Geometry_Part), then Create Simulation.
// The viewport, the study, the files on disk and the Home card show the new part only, and
// nothing of the removed part's study is left to open or copy from (it stayed in the tab
// after the last geometry was removed: Create Simulation offered it under "Start from").
const GEOM = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry');
const stamp = () => Date.now().toString(36);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** `fixture` copied to a folder of its own as Part.step (both parts have that file name). */
function asPartStep(root, sub, fixture) {
  const dir = join(root, sub);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'Part.step');
  cpSync(join(GEOM, fixture), file);
  return file;
}

async function createProject(page, title) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  return page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' })).project.id,
    title,
  );
}

async function openProject(page, pid) {
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

const json = async (request, url) => {
  // A poll can reuse a keep-alive socket just as the server closes it: retry the read.
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
};

/** What the viewport draws: the shown geometry's id and its part's size and point checksum. */
const shown = (page) =>
  page.evaluate(() => {
    const w = window.__CFD_W16__ || {};
    const fp = w.fingerprint || {};
    return {
      id: (w.geometry && w.geometry.id) || null,
      ready: !!w.ready,
      nCells: fp.nCells || 0,
      checksum: fp.mesh_checksum || null,
      bounds: fp.bounds || null,
    };
  });

/** Add a part with the Add geometry file picker; its id, once the viewport draws it. */
async function addPart(page, request, pid, file) {
  const ids = async () =>
    ((await json(request, `/api/project?project_id=${encodeURIComponent(pid)}`)).project?.geometries || []).map((g) => g.id);
  const before = await ids();
  await page.locator('#geometry-file-input').setInputFiles(file);
  await expect.poll(async () => (await ids()).length, { timeout: 120_000 }).toBe(before.length + 1);
  const id = (await ids()).find((g) => !before.includes(g));
  await expect
    .poll(async () => {
      const s = await shown(page);
      return s.ready && s.id;
    }, { timeout: 60_000 })
    .toBe(id);
  return id;
}

/** The studies Create Simulation offers under "Start from" ("" is "None - empty study"). */
async function startFromChoices(page) {
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  const values = await page.locator('#cs-copy-from option').evaluateAll((opts) => opts.map((o) => o.value));
  await page.locator('#cs-cancel').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden();
  return values;
}

async function createStudy(page) {
  const before = await page.evaluate(() => window.__CFD_W17__?.simulation?.id || null);
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__?.simulation?.id || null)).not.toBe(before);
  return page.evaluate(() => window.__CFD_W17__.simulation.id);
}

/** Every geometry folder of the project: its name, its id.json id and its source.step's hash. */
function geometryFolders(root) {
  return readdirSync(root).map((name) => {
    const dir = join(root, name);
    return {
      name,
      id: JSON.parse(readFileSync(join(dir, 'id.json'), 'utf8')).id,
      sha: sha256(readFileSync(join(dir, 'source.step'))),
    };
  });
}

test('a part removed and a changed part of the same file name added: Create Simulation keeps the new part', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const tmp = mkdtempSync(join(tmpdir(), 'magnusim-same-name-'));
  try {
    const oldFile = asPartStep(tmp, 'first-export', 'elbow.step');
    const newFile = asPartStep(tmp, 'changed-export', 'transient-test.step');
    const pid = await createProject(page, `e2e same name part ${stamp()}`);
    const q = (path) => `${path}?project_id=${encodeURIComponent(pid)}`;
    await openProject(page, pid);

    // The first part, with a study on it.
    const oldId = await addPart(page, request, pid, oldFile);
    const oldShown = await shown(page);
    const oldStudy = await createStudy(page);
    const first = (await json(request, q('/api/project'))).project;
    const geomRoot = dirname(dirname(first.geometries[0].step_path));
    expect(geometryFolders(geomRoot).map((g) => g.name)).toEqual(['Geometry_Part']);

    // Remove it from the Geometry panel (its study goes with it).
    await page.locator(`#left-tree li[data-w16-geom="${oldId}"] > .tree-row`).click();
    await page.locator('#panel-geometry .mat-clear-link', { hasText: 'Delete' }).click();
    await expect(page.locator('#modal-confirm')).toBeVisible();
    await page.locator('#cf-confirm').click();
    await expect.poll(async () => ((await json(request, q('/api/project'))).project.geometries || []).length).toBe(0);
    // Nothing of the removed part's study stays open in the tab.
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__?.simulation?.id || null)).toBeNull();
    await expect(page.locator(`#left-tree [data-w17-sim-id="${oldStudy}"]`)).toHaveCount(0);

    // The changed part, from a file of the same name: the same folder name.
    const newId = await addPart(page, request, pid, newFile);
    expect(newId).not.toBe(oldId);
    const newShown = await shown(page);
    expect(newShown.checksum).not.toBe(oldShown.checksum);
    expect(newShown.nCells).not.toBe(oldShown.nCells);
    // Create Simulation offers no study of the removed part to start from.
    expect(await startFromChoices(page)).toEqual(['']);

    // Create Simulation: the study is on the new part, and the viewport still draws it.
    const newStudy = await createStudy(page);
    expect(newStudy).not.toBe(oldStudy);
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__?.simulation?.geometry_id)).toBe(newId);
    await page.waitForTimeout(1_500);
    expect(await shown(page)).toEqual(newShown);
    const studies = (await json(request, q('/api/simulation'))).simulations || [];
    expect(studies.map((s) => [s.id, s.geometry_id])).toEqual([[newStudy, newId]]);

    // On disk: one geometry folder, the new part's, holding the new file; the old one is gone.
    expect(geometryFolders(geomRoot)).toEqual([{ name: 'Geometry_Part', id: newId, sha: sha256(readFileSync(newFile)) }]);
    const project = (await json(request, q('/api/project'))).project;
    expect(project.geometry.id).toBe(newId);
    const meta = await json(request, `${q('/api/geometry/cad')}&geometry_id=${encodeURIComponent(newId)}&part=preview`);
    expect(meta.bounds).toEqual(project.geometry.fingerprint.bounds);

    // The Home card: its picture is the new part's thumbnail.
    const card = async () => ((await json(request, '/api/projects')).projects || []).find((p) => p.id === pid);
    // Where no picture can be made (no OpenGL for the renderer: GitHub's runner, or
    // MAGNUSIM_TEST_THUMB_FAIL), the thumbnail answers "render failed": then no picture
    // at all, never the removed part's, and the card shows its initials.
    const thumbState = async () => {
      const c = await card();
      if (c && c.thumb_url && !/pending/.test(c.thumb_url)) return 'made';
      const r = await request.get(`/api/geometry/thumb?project_id=${encodeURIComponent(pid)}`);
      if (r.status() === 200) return 'made';
      return r.status() === 500 && /thumb render failed/.test(await r.text()) ? 'unavailable' : 'pending';
    };
    await expect.poll(thumbState, { timeout: 120_000 }).not.toBe('pending');
    if ((await thumbState()) === 'unavailable') {
      test.info().annotations.push({ type: 'thumbnail', description: 'the renderer cannot run here: checked that no picture is shown' });
      expect(existsSync(join(geomRoot, 'Geometry_Part', 'thumb.png'))).toBe(false);
      await page.goto('/#/');
      await expect(page.locator(`.home-card[data-project-id="${pid}"] .home-thumb span`)).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(3_000);
      await expect(page.locator(`.home-card[data-project-id="${pid}"] img.home-thumb-img`)).toHaveCount(0);
    } else {
      await expect.poll(async () => {
        const c = await card();
        return c && c.thumb_url && !/pending/.test(c.thumb_url) ? c.thumb_url : null;
      }, { timeout: 120_000 }).not.toBeNull();
      const thumbUrl = (await card()).thumb_url;
      const pic = await request.get(thumbUrl);
      expect(pic.ok()).toBe(true);
      expect(sha256(await pic.body())).toBe(sha256(readFileSync(join(geomRoot, 'Geometry_Part', 'thumb.png'))));
      await page.goto('/#/');
      await expect(page.locator(`.home-card[data-project-id="${pid}"] img.home-thumb-img`)).toHaveAttribute('src', thumbUrl, {
        timeout: 30_000,
      });
    }

    // After a reload: the same part and the one study.
    await openProject(page, pid);
    await expect
      .poll(async () => {
        const s = await shown(page);
        return s.ready && s.checksum;
      }, { timeout: 60_000 })
      .toBe(newShown.checksum);
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__?.simulation?.id || null)).toBe(newStudy);
    expect(await startFromChoices(page)).toEqual(['', newStudy]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
