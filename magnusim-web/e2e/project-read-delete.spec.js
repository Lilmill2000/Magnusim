import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

// Home reads the active project (GET /api/project) when it loads. For a project with more
// than one geometry that read also wrote: it saved project.json through the Python worker
// (a new "Modified" time) and made the project the active one again. The worker answers one
// request at a time, so that save can wait behind an earlier, slow request; a project
// deleted on Home meanwhile came back: the save made its folder again with a project.json,
// and the read made it the active project. After a refresh its card was on Home again.
// A read now saves nothing; a save that does wait there (a geometry or study switch) is
// refused by the worker once its project is gone, and the switch answers that the project
// was deleted.
//
// A server of its own. Its test switches, inert until their files are made:
//   MAGNUSIM_TEST_PROJECT_WRITE_HOLD  the worker holds a project.json save of the project
//                                     the file names while the file is there (a busy
//                                     worker); `held <id>` / `end <id>` lines in <file>.log.
//   MAGNUSIM_TEST_PREVIEW_HOLD        a CAD preview, once made, waits to be placed while the
//                                     file is there; `made <step>` / `end <step>` in <file>.log.
const GEOM = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry');
const ROUND = join(GEOM, 'transient-test.step');
const TEARDROP = join(GEOM, 'transient-test-teardrop.step');
const stamp = () => Date.now().toString(36);

const getJson = async (request, url) => {
  // A poll can reuse a keep-alive socket just as the server closes it: retry the read.
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
};

const logged = (log, line) => (existsSync(log) ? readFileSync(log, 'utf8') : '').split(/\r?\n/).includes(line);

/** Home's GET of the active project (not /api/project/tree, /hydrate, ...). */
const isProjectRead = (r) => new URL(r.url()).pathname === '/api/project' && r.request().method() === 'GET';

test.describe('Home reads the active project while it is deleted', () => {
  let host;
  let writeHold;
  let previewHold;
  test.beforeAll(async () => {
    const tmp = e2eTemp('project-read');
    writeHold = join(tmp, 'write-hold');
    previewHold = join(tmp, 'preview-hold');
    host = await startHost({
      name: 'project-read',
      tmp,
      env: { MAGNUSIM_TEST_PROJECT_WRITE_HOLD: writeHold, MAGNUSIM_TEST_PREVIEW_HOLD: previewHold },
    });
  });
  test.afterAll(() => {
    for (const f of [writeHold, previewHold]) if (f) rmSync(f, { force: true });
    if (host) host.stop();
  });

  const listed = (request) => async () => ((await getJson(request, `${host.base}/api/projects`)).projects || []).map((p) => p.id);

  /**
   * A new project with two geometries, the active project once they are in: its id, and
   * the STEP of its active geometry (the last one imported).
   */
  async function twoGeometryProject(request, title) {
    const base = host.base;
    const made = await (
      await request.post(`${base}/api/project`, {
        data: { title, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' },
      })
    ).json();
    expect(made.id, JSON.stringify(made)).toBeTruthy();
    let step = '';
    for (const [file, name] of [
      [ROUND, 'round.step'],
      [TEARDROP, 'teardrop.step'],
    ]) {
      const r = await request.post(`${base}/api/geometry/import`, { data: { project_id: made.id, step_path: file, filename: name } });
      const text = await r.text();
      expect(r.ok(), text.slice(0, 400)).toBe(true);
      step = JSON.parse(text).geometry.step_path;
    }
    // The imports' thumbnail render ends first (a card's request joins it).
    const thumb = `${base}/api/geometry/thumb?project_id=${encodeURIComponent(made.id)}`;
    await expect.poll(async () => (await request.get(thumb)).status(), { timeout: 120_000 }).not.toBe(202);
    return { pid: made.id, step };
  }

  /** Delete the project on Home, through its card and the two-step confirm. */
  async function deleteOnHome(page, pid) {
    const card = page.locator(`.home-card[data-project-id="${pid}"]`);
    await card.click();
    await page.locator('#home-delete-project').click();
    await expect(page.locator('#modal-delete-project')).toBeVisible();
    await page.locator('#dp-confirm').click();
    await page.locator('#dp-confirm').click();
    await expect(page.locator('#modal-delete-project')).toBeHidden();
    await expect(card).toHaveCount(0);
  }

  /**
   * Reload Home and wait until it shows the server's project list (not the list it kept
   * from before the reload), and has read the active project. The card ids it shows.
   */
  async function reloadHome(page, request) {
    await page.reload();
    await page.waitForFunction(() => !!(window.__CFD_W16__ && window.__CFD_W16__.hydrated), null, { timeout: 60_000 });
    const server = ((await getJson(request, `${host.base}/api/projects`)).projects || []).map((p) => p.id).sort();
    const shown = () => page.locator('.home-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-project-id')));
    await expect.poll(async () => (await shown()).slice().sort().join(' '), { timeout: 30_000 }).toBe(server.join(' '));
    return shown();
  }

  /** What is left of a deleted project after Home's read of it ended (all soft checks). */
  async function expectStaysDeleted(page, request, pid) {
    const folder = join(host.projects, pid);
    const left = existsSync(folder) ? readdirSync(folder, { recursive: true }).join(', ') || '(empty folder)' : '';
    expect.soft(left, `the deleted project's folder is back: ${folder}`).toBe('');
    const active = (await getJson(request, `${host.base}/api/projects`)).active_project_id;
    expect.soft(active, 'the deleted project is the active project again').not.toBe(pid);
    // What the user sees after a refresh: no card for it, and Home holds no such project.
    const cards = await reloadHome(page, request);
    expect.soft(cards, "the deleted project's card is back on Home after a refresh").not.toContain(pid);
    const shownProject = await page.evaluate(() => (window.__CFD_W16__.project && window.__CFD_W16__.project.id) || null);
    expect.soft(shownProject, 'Home holds the deleted project as its project after a refresh').not.toBe(pid);
    expect(await listed(request)()).not.toContain(pid);
  }

  test("a project deleted while Home's read of it waits on the worker stays deleted", async ({ page, request }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    const { pid } = await twoGeometryProject(request, `e2e read delete ${stamp()}`);
    expect((await getJson(request, `${host.base}/api/projects`)).active_project_id).toBe(pid);

    // The worker holds this project's next project.json save (as behind a slow request).
    const log = `${writeHold}.log`;
    rmSync(log, { force: true });
    writeFileSync(writeHold, pid);
    let answered = false;
    page.on('response', (r) => {
      if (isProjectRead(r)) answered = true;
    });
    await page.goto(`${host.base}/#/`);
    const card = page.locator(`.home-card[data-project-id="${pid}"]`);
    await card.waitFor({ timeout: 60_000 });
    // Home's read of the active project waits on its save (a read that saves nothing
    // answers instead).
    await expect
      .poll(() => (logged(log, `held ${pid}`) ? 'held' : answered ? 'answered' : ''), { timeout: 60_000 })
      .not.toBe('');
    const held = logged(log, `held ${pid}`);
    test.info().annotations.push({ type: 'read', description: held ? 'waited on its save' : 'saved nothing' });

    await deleteOnHome(page, pid);
    await expect.poll(listed(request)).not.toContain(pid);
    expect(existsSync(join(host.projects, pid))).toBe(false);

    // The save goes on and Home's read answers.
    rmSync(writeHold, { force: true });
    if (held) await expect.poll(() => logged(log, `end ${pid}`), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => answered, { timeout: 60_000 }).toBe(true);

    await expectStaysDeleted(page, request, pid);
  });

  test("a project deleted while Home's read of it makes its CAD preview stays deleted", async ({ page, request }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    const { pid, step } = await twoGeometryProject(request, `e2e read preview delete ${stamp()}`);
    expect((await getJson(request, `${host.base}/api/projects`)).active_project_id).toBe(pid);
    // The active geometry (the last import) loses its preview: Home's read makes it again.
    for (const f of ['cad_faces.vtp', 'cad_edges.vtp', 'cad_preview.json']) rmSync(join(dirname(step), f), { force: true });

    const log = `${previewHold}.log`;
    rmSync(log, { force: true });
    writeFileSync(previewHold, '');
    let answered = false;
    page.on('response', (r) => {
      if (isProjectRead(r)) answered = true;
    });
    await page.goto(`${host.base}/#/`);
    await page.locator(`.home-card[data-project-id="${pid}"]`).waitFor({ timeout: 60_000 });
    await expect
      .poll(() => (logged(log, `made ${step}`) ? 'made' : answered ? 'answered' : ''), { timeout: 120_000 })
      .not.toBe('');
    const held = logged(log, `made ${step}`);
    test.info().annotations.push({ type: 'read', description: held ? 'waited on its CAD preview' : 'made no preview' });

    await deleteOnHome(page, pid);
    await expect.poll(listed(request)).not.toContain(pid);
    expect(existsSync(join(host.projects, pid))).toBe(false);

    rmSync(previewHold, { force: true });
    if (held) await expect.poll(() => logged(log, `end ${step}`), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => answered, { timeout: 60_000 }).toBe(true);

    await expectStaysDeleted(page, request, pid);
  });

  test('a project deleted while a geometry switch and a study switch wait on the worker to save stays deleted', async ({ page, request }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    const { pid } = await twoGeometryProject(request, `e2e switch delete ${stamp()}`);
    const proj = (await getJson(request, `${host.base}/api/project?project_id=${encodeURIComponent(pid)}`)).project;
    const other = proj.geometries.find((g) => g.id !== proj.active_geometry_id).id;
    // A study on each geometry; the second one made is the active study.
    const studies = [];
    for (const gid of [other, proj.active_geometry_id]) {
      const r = await request.post(`${host.base}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
      const text = await r.text();
      expect(r.ok(), text.slice(0, 400)).toBe(true);
      studies.push(JSON.parse(text).simulation.id);
    }
    const catalog = join(host.projects, pid, 'simulations.json');
    const activeStudy = () => (existsSync(catalog) ? JSON.parse(readFileSync(catalog, 'utf8')).active_id : null);
    expect(activeStudy()).toBe(studies[1]);
    await page.goto(`${host.base}/#/`);
    await page.locator(`.home-card[data-project-id="${pid}"]`).waitFor({ timeout: 60_000 });

    // Other tabs show the project's other geometry, and its other study: the worker holds
    // the first save, and the second waits behind it (the worker answers one at a time).
    // The tabs are stand-ins (their requests): what they show then is not checked here.
    const log = `${writeHold}.log`;
    rmSync(log, { force: true });
    writeFileSync(writeHold, pid);
    const switching = request.post(`${host.base}/api/geometry/activate`, { data: { project_id: pid, geometry_id: other } });
    await expect.poll(() => logged(log, `held ${pid}`), { timeout: 60_000 }).toBe(true);
    const switchingStudy = request.post(`${host.base}/api/simulation/activate`, { data: { project_id: pid, simulation_id: studies[0] } });
    // Its catalog is written first, then its project.json save is sent to the worker.
    await expect.poll(activeStudy, { timeout: 30_000 }).toBe(studies[0]);

    await deleteOnHome(page, pid);
    await expect.poll(listed(request)).not.toContain(pid);
    expect(existsSync(join(host.projects, pid))).toBe(false);

    // The saves run on a project that is gone: the switches answer that, and nothing is
    // made again.
    rmSync(writeHold, { force: true });
    await expect.poll(() => logged(log, `end ${pid}`), { timeout: 60_000 }).toBe(true);
    for (const [what, answer] of [
      ['the geometry switch', await switching],
      ['the study switch', await switchingStudy],
    ]) {
      const text = (await answer.text()).slice(0, 400);
      expect.soft(answer.status(), `${what}: ${text}`).toBe(404);
      expect.soft(text, what).toContain('project deleted while it was saved');
    }

    await expectStaysDeleted(page, request, pid);
  });

  test("opening Home does not change the active project's Modified time", async ({ page, request }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    const { pid: a } = await twoGeometryProject(request, `e2e read modified a ${stamp()}`);
    // B is modified after A; A is the active project.
    const b = (
      await (
        await request.post(`${host.base}/api/project`, {
          data: { title: `e2e read modified b ${stamp()}`, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' },
        })
      ).json()
    ).id;
    const opened = await request.post(`${host.base}/api/project/open`, { data: { project_id: a } });
    expect(opened.ok(), await opened.text()).toBe(true);
    const modified = async (id) => ((await getJson(request, `${host.base}/api/projects`)).projects || []).find((p) => p.id === id)?.updated_at;
    const aBefore = await modified(a);
    expect(aBefore < (await modified(b)), `A ${aBefore} is older than B`).toBe(true);
    const aJson = join(host.projects, a, 'project.json');
    const aStamp = statSync(aJson).mtimeMs;

    // Home reads the active project when it loads ...
    const read = page.waitForResponse(isProjectRead, { timeout: 120_000 });
    await page.goto(`${host.base}/#/`);
    expect((await read).ok()).toBe(true);
    await page.waitForFunction(() => !!(window.__CFD_W16__ && window.__CFD_W16__.hydrated), null, { timeout: 60_000 });

    // ... and, after a refresh, still lists B (modified last) before A, which only was read.
    const cards = await reloadHome(page, request);
    expect.soft(cards.indexOf(b), `B is listed before A (most recently modified first): ${cards.join(', ')}`).toBeLessThan(cards.indexOf(a));
    expect.soft(await modified(a), "A's Modified time").toBe(aBefore);
    expect(statSync(aJson).mtimeMs, "Home's read wrote A's project.json").toBe(aStamp);
  });
});
