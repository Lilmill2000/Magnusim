import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './support/stress.js';

// The Simulation panel reads the runtime's study state when it renders and listens for
// cfd:study from an effect (React runs it one task after the panel appears when the runtime
// opens the panel from a promise callback, as the tree does after a study switch). A study
// change the runtime published in between was lost: the panel kept the old name while the
// tree and the server had the new one, until something else changed.
//
// The timing is forced: the answer to a study save (the rename the panel's pencil makes) is
// held in the page and let through the moment the panel first appears, before its effects.
const ROUND = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const stamp = () => Date.now().toString(36);

test('a study change that lands as the Simulation panel opens shows in the panel', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e panel late state ${stamp()}`,
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
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();
  const oldName = await page.evaluate(() => window.__CFD_STUDY_STATE__ && window.__CFD_STUDY_STATE__.name);
  expect(oldName).toBeTruthy();
  const newName = `Renamed ${stamp()}`;

  const panel = page.locator('#panel-study-settings');
  const title = panel.locator('[data-panel-title="1"]');
  const row = page.locator(`#left-tree li[data-w17-sim-id="${sid}"] > .tree-row`).first();
  // The panel is closed, and the page is quiet.
  await page.evaluate(() => window.__CFD_OPEN_TREE_DETAIL__(''));
  await expect(panel).toBeHidden();
  await expect(row).toContainText(oldName);
  await page.waitForTimeout(1_000);

  // Save the new name through the runtime (what the panel's rename calls); its answer is held.
  await page.evaluate((name) => {
    const realFetch = window.fetch;
    const late = { titleAtRelease: null, titleAtPublish: null, published: null, order: [], restore: () => (window.fetch = realFetch) };
    window.__late = late;
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    let inHand = () => {};
    late.inHand = new Promise((r) => (inHand = r));
    late.release = release;
    let armed = true;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const post = String((init && init.method) || 'GET').toUpperCase() === 'POST';
      if (!armed || !post || url.pathname !== '/api/simulation/update') return realFetch(input, init);
      armed = false;
      return realFetch(input, init).then(async (r) => {
        const status = r.status;
        const ok = r.ok;
        const text = await r.text();
        inHand(status);
        await gate;
        // The server's own answer, handed over now (json() answers within this microtask run).
        return { ok, status, headers: r.headers, json: async () => JSON.parse(text), text: async () => text };
      });
    };
    // Who hears the new name first: the runtime's publish, then the panel's subscription.
    const host = document.getElementById('panel-study-settings');
    window.addEventListener('cfd:study', (e) => {
      if (late.published || !e.detail || e.detail.name !== name) return;
      late.published = e.detail.name;
      late.titleAtPublish = host.querySelector('[data-panel-title="1"]')?.textContent ?? null;
      late.order.push('publish');
    });
    const add = window.addEventListener;
    window.addEventListener = function (type, ...rest) {
      if (type === 'cfd:study') late.order.push('subscribe');
      return add.call(this, type, ...rest);
    };
    late.unpatch = () => (window.addEventListener = add);
    late.save = window.__CFD_STUDY_UPDATE__({ name }).then(
      () => 'saved',
      (e) => String(e && e.message),
    );
  }, newName);
  expect(await page.evaluate(() => window.__late.inHand)).toBe(200);
  // The server has the new name; the page has not heard it yet.
  await expect
    .poll(async () => ((await (await request.get(q('/api/simulation'))).json()).simulations || []).find((s) => s.id === sid)?.name)
    .toBe(newName);
  expect(await page.evaluate(() => window.__CFD_STUDY_STATE__.name)).toBe(oldName);

  // Open the panel the way the tree does after a study switch: from a promise callback.
  // The held answer goes through the moment the panel is first on screen.
  await page.evaluate(() => {
    const late = window.__late;
    const host = document.getElementById('panel-study-settings');
    const mo = new MutationObserver(() => {
      const t = host.querySelector('[data-panel-title="1"]');
      if (!t) return;
      mo.disconnect();
      late.titleAtRelease = t.textContent;
      late.order.push('panel on screen');
      late.release();
    });
    mo.observe(host, { childList: true, subtree: true, characterData: true });
    return Promise.resolve().then(() => window.__CFD_OPEN_TREE_DETAIL__('study-settings', { toggle: false }));
  });
  expect(await page.evaluate(() => window.__late.save)).toBe('saved');
  await expect(panel).toBeVisible();

  // The forced timing really ran: the panel was on screen with the old name when the runtime
  // published the new one.
  const late = await page.evaluate(() => {
    window.__late.restore();
    window.__late.unpatch();
    const { titleAtRelease, titleAtPublish, published, order } = window.__late;
    return { titleAtRelease, titleAtPublish, published, order, runtime: window.__CFD_STUDY_STATE__.name };
  });
  console.log('[late-state]', JSON.stringify(late));
  expect(late.titleAtRelease).toBe(oldName);
  expect(late.published).toBe(newName);
  expect(late.titleAtPublish).toBe(oldName);
  expect(late.runtime).toBe(newName);
  // The tree shows the new name ...
  await expect(row).toContainText(newName);
  // ... and so does the panel the user is looking at.
  await expect(title, `the panel still says "${oldName}" after the runtime published "${newName}"`).toHaveText(newName, {
    timeout: 5_000,
  });
  // It stays so.
  await page.waitForTimeout(1_500);
  await expect(title).toHaveText(newName);
});
