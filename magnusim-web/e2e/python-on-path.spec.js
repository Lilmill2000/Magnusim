import { expect, test } from '@playwright/test';
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON } from '../scripts/python-env.js';
import { e2eTemp, startHost } from './support/host-server.mjs';

// With no python/.venv (GitHub: setup-python puts python on PATH) the app runs a bare
// "python3"/"python", which is never a file: the geometry code's existsSync check called
// it missing, so no Home card ever got its picture (and the deferred STEP write and the
// mesh surface pre-warm never ran). Here the server runs the app's own interpreter by its
// bare name, found on PATH. Where pictures can be rendered the card shows one; where the
// renderer cannot run (no OpenGL, GitHub) the reason is the render, never "PYTHON missing".
const HERE = dirname(fileURLToPath(import.meta.url));
const STEP = resolve(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'elbow.step');

/** The app's interpreter by bare name, and PATH with its folder first. */
function bareOnPath() {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  if (!isAbsolute(PYTHON)) return { bare: PYTHON, env: { MAGNUSIM_PYTHON: PYTHON } };
  // Its file name as is ("python.exe" on Windows): a bare "python" is also the app's own
  // python/ folder, which the old check found by accident.
  const bare = basename(PYTHON);
  return { bare, env: { MAGNUSIM_PYTHON: bare, [pathKey]: `${dirname(PYTHON)}${delimiter}${process.env[pathKey] || ''}` } };
}

let host;
const py = bareOnPath();

test.beforeAll(async () => {
  host = await startHost({ name: 'python-on-path', tmp: e2eTemp('python-on-path'), env: py.env });
});

test.afterAll(() => {
  if (host) host.stop();
});

test(`a Python found on PATH by its bare name ("${py.bare}") makes the Home card's picture`, async ({ page, request }) => {
  test.setTimeout(240_000);
  const made = await (await request.post(`${host.base}/api/project`, {
    data: { title: 'e2e python on PATH', description: '', category: 'Other', units: 'Metric', folder: 'My Projects' },
  })).json();
  const pid = made.id;
  const imported = await request.post(`${host.base}/api/geometry/import`, { data: { project_id: pid, step_path: STEP, filename: 'elbow.step' } });
  expect(imported.ok(), await imported.text()).toBe(true);

  // The picture is made (200), or the render itself failed (500): never "PYTHON missing".
  let last = null;
  await expect
    .poll(async () => {
      const r = await request.get(`${host.base}/api/geometry/thumb?project_id=${encodeURIComponent(pid)}`);
      last = { status: r.status(), body: r.status() === 200 ? null : await r.text() };
      return last.status;
    }, { timeout: 180_000, intervals: [1_000] })
    .not.toBe(202);
  expect(String(last.body || ''), 'the app called its Python missing').not.toMatch(/PYTHON missing/i);

  await page.goto(`${host.base}/#/`);
  const card = page.locator(`.home-card[data-project-id="${pid}"]`);
  await card.waitFor({ timeout: 60_000 });
  if (last.status === 200) {
    const img = card.locator('img.home-thumb-img');
    await expect(img).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  } else {
    expect(last.status, last.body).toBe(500);
    expect(last.body).toMatch(/thumb render failed/);
    test.info().annotations.push({ type: 'thumbnail', description: `the renderer cannot run here: ${String(last.body).slice(0, 200)}` });
    await expect(card.locator('.home-thumb span')).toBeVisible({ timeout: 30_000 });
  }
});
