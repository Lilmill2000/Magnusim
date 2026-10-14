import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

// The Materials panel reads the runtime's study state when it renders (which analysis: one
// fluid, or several materials) and listens for cfd:study from an effect, which React runs a
// task after the panel appears when the runtime opens it from a promise callback (the tree's
// "+" on another study does). A study the runtime published in between was lost: a
// heat-transfer study's panel kept the one-fluid study's "Fluid" editor, with no material
// types to choose, until something else published.
//
// The timing is forced, on the real runtime and server: a switch from a one-fluid study to a
// heat-transfer study (the heat example: a fluid and a solid) is started from the tree, its
// answer is held in the page, and the Materials panel opens from a promise callback while the
// runtime's study is still the one-fluid one. The answer goes through the moment the panel is
// first on screen. The rest of the switch is held until the panel has been checked, so no
// later publish can mend it.
const HERE = dirname(fileURLToPath(import.meta.url));
const PART = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'two-boxes-shared-face.brep');
let host;

test.beforeAll(async () => {
  host = await startHost({ name: 'materials-late', pluginsFrom: 'python/tests/fixtures/heat-plugins' });
});

test.afterAll(() => {
  if (host) host.stop();
});

async function createStudy(page, analysisKey) {
  const before = await page.evaluate(() => window.__CFD_W17__ && window.__CFD_W17__.activeId);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator(`#cs-type-list [data-analysis-key="${analysisKey}"]`).click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  await page.waitForFunction(
    ([old, key]) => {
      const id = window.__CFD_W17__ && window.__CFD_W17__.activeId;
      const st = window.__CFD_STUDY_STATE__;
      return !!id && id !== old && !!st && st.id === id && st.analysis_type === key;
    },
    [before, analysisKey],
    { timeout: 30_000 },
  );
  return page.evaluate(() => window.__CFD_W17__.activeId);
}

test("a study switch that lands as the Materials panel opens shows the new study's materials", async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.goto(`${host.base}/#/`);
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e materials late state ${Date.now().toString(36)}`,
  );
  await page.goto(`${host.base}/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(PART);
  await expect
    .poll(async () => ((await (await request.get(`${host.base}/api/project?project_id=${pid}`)).json()).project?.geometries || []).length, {
      timeout: 120_000,
    })
    .toBe(1);
  const heat = await createStudy(page, 'example_heat_steady');
  const fluid = await createStudy(page, 'incompressible_steady');
  expect(heat).not.toBe(fluid);

  const picker = page.locator('#panel-material-picker .cfd-island');
  const heatRow = page.locator(`#left-tree li[data-w17-sim-id="${heat}"] > .tree-row`).first();
  // The one-fluid study is shown, no panel is open, and the page is quiet.
  await page.evaluate(() => window.__CFD_OPEN_TREE_DETAIL__(''));
  await expect(page.locator('#panel-material-picker')).toBeHidden();
  await expect(heatRow).toBeVisible();
  await page.waitForTimeout(1_000);

  // Hold the switch's answer, and then the rest of the switch; note who hears the heat study first.
  await page.evaluate((heatId) => {
    const realFetch = window.fetch;
    const late = { shownAtRelease: null, shownAtPublish: null, published: null, order: [], restore: () => (window.fetch = realFetch) };
    window.__late = late;
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    late.release = release;
    let releaseRest = () => {};
    const rest = new Promise((r) => (releaseRest = r));
    late.releaseRest = releaseRest;
    let inHand = () => {};
    late.inHand = new Promise((r) => (inHand = r));
    let armed = true;
    let released = false;
    gate.then(() => (released = true));
    // What the panel shows: the one-fluid editor, or a study with several material types.
    late.shown = () => {
      const host = document.getElementById('panel-material-picker');
      if (!host || !host.querySelector('.cfd-island > *')) return null;
      if (host.querySelector('[data-material-model="1"]')) return 'material types';
      if (host.querySelector('[aria-label="Fluid"]')) return 'one fluid';
      return host.querySelector('[data-material-loading="1"]')?.textContent || 'other';
    };
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const post = String((init && init.method) || 'GET').toUpperCase() === 'POST';
      if (armed && post && url.pathname === '/api/simulation/activate') {
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
      }
      // The switch's next step (and so its later publishes) waits until the panel is checked.
      if (released && url.pathname === '/api/project/hydrate') return rest.then(() => realFetch(input, init));
      return realFetch(input, init);
    };
    window.addEventListener('cfd:study', (e) => {
      if (late.published || !e.detail || e.detail.id !== heatId) return;
      late.published = e.detail.analysis_type;
      late.shownAtPublish = late.shown();
      late.order.push('publish');
    });
    const add = window.addEventListener;
    window.addEventListener = function (type, ...more) {
      if (type === 'cfd:study') late.order.push('subscribe');
      return add.call(this, type, ...more);
    };
    late.unpatch = () => (window.addEventListener = add);
  }, heat);
  // The tree switches to the heat study; its answer is held.
  await heatRow.click();
  expect(await page.evaluate(() => window.__late.inHand)).toBe(200);
  expect(await page.evaluate(() => window.__CFD_STUDY_STATE__.id), 'the page has not heard the switch yet').toBe(fluid);

  // Open the Materials panel from a promise callback; the held answer goes through the moment
  // the panel is first on screen.
  await page.evaluate(() => {
    const late = window.__late;
    const host = document.getElementById('panel-material-picker');
    const mo = new MutationObserver(() => {
      const shown = late.shown();
      if (!shown) return;
      mo.disconnect();
      late.shownAtRelease = shown;
      late.order.push('panel on screen');
      late.release();
    });
    mo.observe(host, { childList: true, subtree: true });
    return Promise.resolve().then(() => window.__CFD_OPEN_TREE_DETAIL__('mat-picker', { toggle: false }));
  });
  await expect(picker).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__late.order.includes('subscribe'))).toBe(true);

  const late = await page.evaluate(() => {
    window.__late.unpatch();
    const { shownAtRelease, shownAtPublish, published, order } = window.__late;
    return { shownAtRelease, shownAtPublish, published, order, runtime: window.__CFD_STUDY_STATE__.analysis_type };
  });
  console.log('[materials-late-state]', JSON.stringify(late));
  // The forced timing ran: the panel was on screen for the one-fluid study when the runtime
  // published the heat study, and it subscribed only after.
  expect(
    late.order.slice(0, 3),
    'timing not forced: the publish must land after the panel is on screen and before it subscribes',
  ).toEqual(['panel on screen', 'publish', 'subscribe']);
  expect(late.shownAtRelease).not.toBe('material types');
  expect(late.shownAtPublish).not.toBe('material types');
  expect(late.published).toBe('example_heat_steady');
  expect(late.runtime).toBe('example_heat_steady');

  // The panel the user is looking at is the heat study's: its material types, fluid and solid,
  // not the one-fluid study's Fluid editor. Nothing else has published since.
  const types = picker.getByLabel('Material type');
  await expect(types, 'the panel kept the one-fluid editor after the runtime published the heat study').toBeVisible({ timeout: 5_000 });
  await expect(types).toHaveValue('example_heat_fluid');
  await expect(types.locator('option')).toHaveText(['Fluid', 'Solid']);

  // Let the switch finish.
  await page.evaluate(() => {
    window.__late.releaseRest();
    window.__late.restore();
  });
  await page.waitForFunction((id) => window.__CFD_W17__.activeId === id && window.__CFD_STUDY_STATE__.id === id, heat, { timeout: 60_000 });
});
