import { expect, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eTemp, startHost } from './support/host-server.mjs';

// Home's project cards never make the browser log an error for their pictures. On a
// machine where the thumbnail renderer cannot run (GitHub's runner: no display, no EGL,
// the renderer crashes) every card's picture failed, each failure was a 404/500 on an
// <img> (a console error), and the cards asked again, so a CAD spec that allows no console
// errors saw dozens. Now an image request for a picture that is not there answers 204 (no
// picture), a card asks again only while the picture is being made (202), and the card
// shows its initials. A render that hangs is stopped at its limit and holds nothing: the
// page's other requests (a rename) are answered meanwhile.
// No WSL: the server's test hook MAGNUSIM_TEST_THUMB_FAIL makes every render fail (1) or
// hang (hang; MAGNUSIM_THUMB_TIMEOUT_MS stops it).
const HERE = dirname(fileURLToPath(import.meta.url));
const STEP = resolve(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'elbow.step');

/**
 * Three more projects with a part each (the seeded sample projects are more). A part's
 * picture starts rendering at its import: `importedAt` is the time just before each import.
 */
async function seedProjects(request, base, tag) {
  const ids = [];
  const importedAt = new Map();
  for (const n of [1, 2, 3]) {
    const made = await (await request.post(`${base}/api/project`, {
      data: { title: `e2e thumb ${tag} ${n}`, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' },
    })).json();
    importedAt.set(made.id, Date.now());
    const imported = await request.post(`${base}/api/geometry/import`, { data: { project_id: made.id, step_path: STEP, filename: `part-${n}.step` } });
    expect(imported.ok(), await imported.text()).toBe(true);
    ids.push(made.id);
  }
  return { ids, importedAt };
}

const thumbProject = (url) => new URL(url).searchParams.get('project_id') || '';

/**
 * The page's console errors, every thumbnail answer it gets (status, project, the server's
 * X-CFD-Thumb reason, when), and when it first asked for each project's picture.
 */
function watch(page) {
  const errors = [];
  const thumbAnswers = [];
  const firstAsked = new Map();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => {
    if (!r.url().includes('/api/geometry/thumb')) return;
    const project = thumbProject(r.url());
    if (!firstAsked.has(project)) firstAsked.set(project, Date.now());
  });
  page.on('response', (r) => {
    if (!r.url().includes('/api/geometry/thumb')) return;
    thumbAnswers.push({ status: r.status(), project: thumbProject(r.url()), why: r.headers()['x-cfd-thumb'] || '', at: Date.now() });
  });
  return { errors, thumbAnswers, firstAsked };
}

/**
 * The cards settle (no picture request for 10 s: a card asks again only while its picture
 * is being made), every card shows its initials, and no answer was an error status.
 */
async function expectQuietCards(page, seen, deadlineMs) {
  const by = Date.now() + deadlineMs;
  let last = seen.thumbAnswers.length;
  let quietSince = Date.now();
  while (Date.now() - quietSince < 10_000) {
    expect(Date.now(), `the cards still ask for pictures: ${JSON.stringify(seen.thumbAnswers)}`).toBeLessThan(by);
    await page.waitForTimeout(500);
    if (seen.thumbAnswers.length !== last) {
      last = seen.thumbAnswers.length;
      quietSince = Date.now();
    }
  }
  expect(seen.thumbAnswers.length).toBeGreaterThanOrEqual(4);
  expect(seen.thumbAnswers.every((a) => a.status === 204 || a.status === 202), JSON.stringify(seen.thumbAnswers)).toBe(true);
  expect(seen.errors.filter((t) => /thumb|Failed to load resource/i.test(t)), seen.errors.join(' | ')).toEqual([]);
  expect(await page.locator('.home-thumb-img').count()).toBe(0);
  expect(await page.locator('.home-thumb span').count()).toBeGreaterThanOrEqual(4);
}

test.describe('renders fail (MAGNUSIM_TEST_THUMB_FAIL=1)', () => {
  let host;
  test.beforeAll(async () => {
    host = await startHost({ name: 'home-thumb-fail', tmp: e2eTemp('home-thumb-fail'), env: { MAGNUSIM_TEST_THUMB_FAIL: '1' } });
  });
  test.afterAll(() => {
    if (host) host.stop();
  });

  test("Home shows every card's initials when no picture can be made, and the browser logs no error", async ({ page, request }) => {
    test.setTimeout(240_000);
    await seedProjects(request, host.base, 'fail');
    const seen = watch(page);
    await page.goto(`${host.base}/#/`);
    await expect.poll(async () => page.locator('.home-card').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(4);
    await expectQuietCards(page, seen, 150_000);
  });
});

test.describe('renders hang (MAGNUSIM_TEST_THUMB_FAIL=hang)', () => {
  const RENDER_LIMIT_MS = 8000;
  let host;
  test.beforeAll(async () => {
    host = await startHost({
      name: 'home-thumb-hang',
      tmp: e2eTemp('home-thumb-hang'),
      env: { MAGNUSIM_TEST_THUMB_FAIL: 'hang', MAGNUSIM_THUMB_TIMEOUT_MS: String(RENDER_LIMIT_MS) },
    });
  });
  test.afterAll(() => {
    if (host) host.stop();
  });

  test('a rename lands while every picture is stuck, then the cards show their initials with no error', async ({ page, request }) => {
    test.setTimeout(400_000);
    const { ids, importedAt } = await seedProjects(request, host.base, 'hang');
    const [pid] = ids;
    const seen = watch(page);
    await page.goto(`${host.base}/#/`);
    const card = page.locator(`.home-card[data-project-id="${pid}"]`);
    await card.waitFor({ timeout: 60_000 });
    // The pictures are being made (none can be: every render hangs): 202 ...
    await expect.poll(() => seen.thumbAnswers.filter((a) => a.status === 202).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    // ... unless a card may honestly have no picture (204): the seeded project with no
    // geometry has nothing to draw, and a render stopped at its limit is remembered as
    // failed. A render starts no earlier than its part's import (this test's parts render
    // from then on) or the page's first ask for it, so a picture asked for before that
    // plus the limit is still being made.
    const notBeingMade = seen.thumbAnswers.filter((a) => {
      if (a.status === 202) return false;
      if (a.status !== 204) return true;
      if (a.why === 'no geometry imported') return ids.includes(a.project);
      const from = Math.min(importedAt.get(a.project) ?? Infinity, seen.firstAsked.get(a.project) ?? Infinity);
      return !(a.why.startsWith('thumb render failed') && a.at >= from + RENDER_LIMIT_MS);
    });
    expect(notBeingMade, JSON.stringify(seen.thumbAnswers)).toEqual([]);
    // ... and the page's own requests are answered meanwhile: a rename lands at once.
    const t0 = Date.now();
    await card.click();
    await page.locator('#home-edit-project').click();
    await expect(page.locator('#np-heading')).toHaveText(/Edit project/);
    await page.locator('#np-title').fill('e2e renamed while pictures hang');
    await page.locator('#np-create').click();
    await expect
      .poll(async () => {
        const r = await request.get(`${host.base}/api/project?project_id=${encodeURIComponent(pid)}`);
        return ((await r.json()).project || {}).title;
      }, { timeout: 15_000 })
      .toBe('e2e renamed while pictures hang');
    await expect(page.locator(`.home-card[data-project-id="${pid}"]`)).toContainText('e2e renamed while pictures hang', { timeout: 15_000 });
    expect(Date.now() - t0, 'the rename waited behind the stuck pictures').toBeLessThan(20_000);
    // Each render is stopped at 8 s (two at a time); the cards then show their initials.
    await expectQuietCards(page, seen, 240_000);
  });
});
