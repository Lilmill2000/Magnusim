import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A study row clicked while another study's switch is still on its way: the study clicked
// last shows its panel, and keeps it. Each switch opened the panel when it landed, also a
// switch a later click had replaced, and the later one's open then toggled it shut: the
// tree showed nothing selected and no panel, and a rename typed there was lost. The
// activate replies are held back so the second click always lands mid-switch.
const ROUND = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const stamp = () => Date.now().toString(36);

test('the study clicked last keeps its panel open when it was clicked during another switch', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e study switch panel ${stamp()}`,
  );
  const q = (path) => `${path}?${new URLSearchParams({ project_id: pid })}`;
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(ROUND);
  await expect
    .poll(async () => ((await (await request.get(q('/api/project'))).json()).project?.geometries || []).length, {
      timeout: 120_000,
    })
    .toBe(1);
  const createStudy = async () => {
    await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
    await page.locator('#btn-create-simulation').click();
    await expect(page.locator('#modal-create-simulation')).toBeVisible();
    await page.locator('#cs-create').click();
    await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
    if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
    return page.evaluate(() => window.__CFD_W17__.activeId);
  };
  const a = await createStudy();
  const b = await createStudy();
  expect(a).not.toBe(b);
  const names = Object.fromEntries(
    ((await (await request.get(q('/api/simulation'))).json()).simulations || []).map((s) => [s.id, s.name]),
  );
  expect(names[a]).not.toBe(names[b]);

  const row = (sid) => page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  const node = (sid) => page.locator(`#left-tree li[data-w17-sim-id="${sid}"]`).first();
  const panel = page.locator('#panel-study-settings');
  const activeId = () => page.evaluate(() => window.__CFD_W17__.activeId);
  /** The study's panel opens, titled with its name, and its row selected, for 2 s. */
  const shows = async (sid) => {
    await expect.poll(activeId).toBe(sid);
    // It opens when the last switch lands (its activate reply is held back 0.8 s, longer
    // on a loaded 2-core runner); then it must stay open.
    await expect(panel, 'panel opens').toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('[data-panel-title="1"]')).toHaveText(names[sid], { timeout: 15_000 });
    for (let i = 0; i < 8; i++) {
      await expect(panel, `panel open, check ${i}`).toBeVisible({ timeout: 1_000 });
      await expect(panel.locator('[data-panel-title="1"]')).toHaveText(names[sid], { timeout: 1_000 });
      await expect(node(sid), `row selected, check ${i}`).toHaveClass(/(^|\s)selected(\s|$)/, { timeout: 1_000 });
      await page.waitForTimeout(250);
    }
  };

  // Each switch's activate reply is held back 0.8 s.
  let landed = 0;
  const slowActivate = async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  };
  await page.route('**/api/simulation/activate**', slowActivate);
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/simulation/activate') landed += 1;
  });
  try {
    // Study A, then study B while A's switch is on its way: B's panel.
    await expect.poll(activeId).toBe(b);
    let before = landed;
    await row(a).click();
    await row(b).click();
    await expect.poll(() => landed - before, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await shows(b);

    // Study A clicked twice in a row (the second while the first switch is on its way).
    before = landed;
    await row(a).click();
    await row(a).click();
    await expect.poll(() => landed - before, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await shows(a);
  } finally {
    await page.unroute('**/api/simulation/activate**', slowActivate);
  }

  // A click on the open study's own row still closes its panel, and the next opens it.
  await row(a).click();
  await expect(panel).toBeHidden();
  await row(a).click();
  await shows(a);
});
