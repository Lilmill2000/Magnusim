import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { QUEUE_PROJECT_A, QUEUE_PROJECT_B, prepareE2eProjectsRoot } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { persistRunAt } from '../scripts/study-io.js';

// Core UI bugs found while building the plugin UI kit (H14), as the user meets them. No WSL:
// - the results legends paint the renders' own lookup table, not a hand-picked rainbow;
// - a job-finished toast (here a queue notice) shows over an open plugin workspace;
// - Home labels 1 to 10 ms of simulated time as the workbench does (0.005 s, not 5.0e-3 s);
// - the Mesh and Run panels show h:mm:ss past an hour, as the viewport chip does (not 62:05);
// - the residual plot's hover tip stays inside the plot at its right edge;
// - a number input shows 999999.9 as 1.0000e+6 (exponent form from a million), not 1000000.
const PROJECT = 'sample-project-steady-state-e2e';

function stage(t0, msg) {
  console.log(`[core-ui-bugs +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

/** The RGB the page shows at one CSS pixel (a 1x1 screenshot, read back through a canvas). */
async function pixelAt(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, png.toString('base64'));
}

test('the results legends paint the lookup table the renders draw with', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/#/p/${PROJECT}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  const got = await page.evaluate(() => {
    // Every lookup table on the renderer's actors (surface, cut planes, particle tracks...).
    const tables = [];
    for (const a of window.__CFD_VIEW__.renderer.getActors()) {
      const m = a.getMapper && a.getMapper();
      // The table the app set (getLookupTable() would make vtk's default for a mapper that has none).
      const lut = m && m.get && m.get('lookupTable').lookupTable;
      if (!lut || !lut.build || !lut.get || !lut.getNumberOfAvailableColors) continue;
      lut.build();
      // RGBA entries, then the below-range, above-range and NaN colours.
      const t = lut.get('table').table;
      // The table holds byte values + 0.5; a mapped colour is that, truncated to a byte.
      if (t && t.length) tables.push(Array.from(t).slice(0, lut.getNumberOfAvailableColors() * 4).map(Math.floor));
    }
    // What each legend bar paints: its gradient's stops, read from the computed style.
    const bars = {};
    for (const id of ['legend', 'legend-b', 'legend-pt']) {
      const bar = document.querySelector(`#${id} .legend-bar`);
      if (!bar) continue;
      const bg = getComputedStyle(bar).backgroundImage;
      const stops = [];
      const re = /rgba?\((\d+),\s*(\d+),\s*(\d+)[^)]*\)\s+([\d.]+)%/g;
      let m;
      while ((m = re.exec(bg))) stops.push({ at: Number(m[4]) / 100, rgb: [Number(m[1]), Number(m[2]), Number(m[3])] });
      bars[id] = { bg, stops };
    }
    return { tables, bars };
  });
  expect(got.tables.length, 'lookup tables on the renderer').toBeGreaterThan(0);
  const tableAt = (lut, f) => {
    const entries = lut.length / 4;
    const i = Math.min(entries - 1, Math.max(0, Math.round(f * (entries - 1))));
    return [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]];
  };
  const gradientAt = (stops, f) => {
    let k = 1;
    while (k < stops.length - 1 && stops[k].at < f) k++;
    const a = stops[k - 1];
    const b = stops[k];
    const w = b.at > a.at ? Math.min(1, Math.max(0, (f - a.at) / (b.at - a.at))) : 0;
    return a.rgb.map((c, j) => c + (b.rgb[j] - c) * w);
  };
  expect(Object.keys(got.bars).length, 'legend bars').toBeGreaterThanOrEqual(2);
  for (const [id, bar] of Object.entries(got.bars)) {
    expect(bar.stops.length, `${id} gradient: ${bar.bg}`).toBeGreaterThanOrEqual(2);
    got.tables.forEach((lut, k) => {
      const off = [];
      for (let s = 0; s <= 64; s++) {
        const f = s / 64;
        const want = tableAt(lut, f);
        const have = gradientAt(bar.stops, f);
        const d = Math.max(...want.map((c, j) => Math.abs(c - have[j])));
        if (d > 4) off.push(`${(f * 100).toFixed(1)}%: legend ${have.map(Math.round)} vs render ${want}`);
      }
      expect(off, `${id} against render table ${k} (${lut.length / 4} colours): where the colours differ`).toEqual([]);
    });
  }
});

test('a job toast shows over an open plugin workspace', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const host = await startHost({ name: 'ui-bugs-toast', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
  const { base } = host;
  try {
    const r = await request.post(`${base}/api/plugin-studies/create`, {
      data: { project_id: PROJECT, plugin: 'ws-demo', kind: 'bench_case', title: 'Toast bench' },
    });
    const j = await r.json();
    expect(r.ok(), JSON.stringify(j)).toBe(true);
    const study = j.study;
    // Once the workspace is open, the next queue poll says a job left the queue (a toast).
    let notice = null;
    await page.route('**/api/compute-queue?**', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (notice) body.failed = [...(Array.isArray(body.failed) ? body.failed : []), notice];
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await page.locator(`#plugin-studies-section [data-plugin-study="${study.id}"] > .tree-row`).click();
    const overlay = page.locator('#workspace-overlay');
    await expect(overlay).toBeVisible();
    await expect(page.frameLocator('#workspace-frame').locator('#bench-title')).toHaveText('Toast bench');
    stage(t0, 'workspace open');
    notice = { id: `toast-e2e-${Date.now()}`, project_id: PROJECT, at: Date.now(), kind: 'mesh', name: 'Mesh e2e', error: 'Toast check', reason: 'failed' };
    const toast = page.locator('#job-finish-toast');
    await expect(toast).toHaveText('Mesh e2e could not start from the queue: Toast check.', { timeout: 30_000 });
    await expect(toast).toHaveCSS('opacity', '1');
    stage(t0, 'toast on');
    // On screen, the toast's own colour shows at its edge, not the workspace drawn over it.
    const box = await toast.boundingBox();
    const bg = await toast.evaluate((el) => getComputedStyle(el).backgroundColor);
    const want = bg.match(/\d+/g).slice(0, 3).map(Number);
    const seen = await pixelAt(page, box.x + 4, box.y + box.height / 2);
    expect(seen, `pixel at the toast's left edge (toast background ${bg})`).toEqual(want);
    await expect(overlay).toBeVisible();
  } finally {
    host.stop();
  }
});

test('Home labels 5 ms of simulated time as the workbench does', async ({ page }) => {
  test.setTimeout(120_000);
  // The server's own list, with this project solving at 5 ms of 10 ms.
  await page.route('**/api/projects', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.projects = (body.projects || []).map((p) =>
      p.id === PROJECT
        ? { ...p, simulating: true, has_run: true, run_status: 'running', x_axis: 'seconds', time_dependency: 'Transient', sim_time: 0.005, sim_end: 0.01 }
        : p,
    );
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/#/');
  const card = page.locator(`#home-grid .home-card[data-project-id="${PROJECT}"]`);
  await expect(card.locator('.home-card-job')).toHaveText('0.005 s / 0.01 s', { timeout: 60_000 });
});

test.describe('panels of a seeded project', () => {
  const A = QUEUE_PROJECT_A;
  const B = QUEUE_PROJECT_B;
  const RUN = 'ui-bugs-long-run';
  // Started 2 h 05 min 10 s before it finished.
  const RUN_MS = 2 * 3600_000 + 5 * 60_000 + 10_000;
  let host;

  test.beforeAll(async () => {
    const tmp = e2eTemp('ui-bugs');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    const finished = Date.now() - 600_000;
    const residuals = [];
    for (let i = 1; i <= 50; i++) {
      const f = Math.pow(10, (-5 * i) / 50);
      residuals.push({ t: i * 10, U: f, p: 10 * f, k: 0.5 * f, omega: 0.3 * f });
    }
    persistRunAt(join(projects, A), 'sim_1', {
      id: RUN,
      name: 'Long run',
      status: 'done',
      mesh_id: 'mesh_1',
      time_dependency: 'Steady-state',
      analysis_key: 'incompressible_steady',
      endTime: 500,
      iteration: 500,
      has_results: false,
      started_at: new Date(finished - RUN_MS).toISOString(),
      finished_at: new Date(finished).toISOString(),
      residuals,
    });
    host = await startHost({ name: 'ui-bugs', projects, tmp, env: { MAGNUSIM_WSL_PRUNE: '0' } });
  });

  test.afterAll(() => {
    if (host) host.stop();
  });

  async function openProject(page, pid) {
    await page.goto(`${host.base}/#/p/${pid}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  }

  test('the Run panel clock past an hour, and the residual tip at the right edge', async ({ page }) => {
    test.setTimeout(180_000);
    await openProject(page, A);
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    const folder = page.locator(`#left-tree [data-w17-sim-id="sim_1"] li[data-w27-sim-control="1"]`).first();
    if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
    await page.locator(`#left-tree [data-w27-run="${RUN}"] > .tree-row .tl`).first().click();
    await expect(runPanel).toHaveAttribute('data-run-id', RUN);
    await expect(runPanel.locator('.sim-finished .mesh-finished-meta')).toContainText('2:05:10');

    // The tip at the last iterations: inside the plot, box and text.
    const wrap = runPanel.locator('[data-residual-wrap="1"]');
    const plot = runPanel.locator('[data-residual-plot="1"]');
    await expect(plot).toBeVisible();
    const box = await plot.boundingBox();
    await page.mouse.move(box.x + box.width * 0.98, box.y + box.height / 2);
    const tip = wrap.locator('.sim-plot-tip');
    await expect(tip).toContainText('Iteration 500');
    const where = await tip.evaluate((el) => {
      const w = el.parentElement.getBoundingClientRect();
      const t = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      return { wrap: [w.left, w.right], tip: [t.left, t.right], text: [text.left, text.right] };
    });
    const inside = (r) => r[0] >= where.wrap[0] - 0.5 && r[1] <= where.wrap[1] + 0.5;
    expect(inside(where.tip), `tip box ${JSON.stringify(where)}`).toBe(true);
    expect(inside(where.text), `tip text ${JSON.stringify(where)}`).toBe(true);
  });

  test('a number past a million reads in exponent form', async ({ page, request }) => {
    test.setTimeout(180_000);
    const list = await (await request.get(`${host.base}/api/bcs?project_id=${A}&simulation_id=sim_1`)).json();
    const bc = { id: 'bc-sci-e2e', name: 'High pressure', bc_type: 'Pressure Outlet', value: 999999.9, unit: 'Pa', faces: [], simulation_id: 'sim_1', project_id: A };
    const saved = await request.post(`${host.base}/api/worker`, {
      data: { method: 'bcs.set', params: { project_id: A, sim_id: 'sim_1', body: { boundary_conditions: [...(list.boundary_conditions || []), bc], simulation_id: 'sim_1' } } },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    await openProject(page, A);
    await page.locator('#left-tree [data-w19-bcs="1"] > .tree-row .tl').first().click();
    await page.locator('#panel-bcs-hub .cfd-island [data-open-bc="bc-sci-e2e"]').click();
    const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
    await expect(editor.locator('[data-bc-title="1"]')).toHaveText('High pressure');
    await expect(editor.getByLabel('Fixed value', { exact: true })).toHaveValue('1.0000e+6');
  });

  test('the Mesh panel clock past an hour', async ({ page }) => {
    test.setTimeout(180_000);
    // The server says B's mesh has been generating for two hours.
    const started = new Date(Date.now() - 2 * 3600_000).toISOString();
    const live = { kind: 'mesh', phase: 'running', project_id: B, mesh_id: 'mesh_1', generate_id: 'ui-bugs-gen', path_kind: 'standard', mesh_name: 'Mesh 1', started_at: started };
    await page.route('**/api/compute-queue?**', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, live, busy: live } });
    });
    await openProject(page, B);
    await page.locator('#left-tree [data-w20-mesh-item="mesh_1"] > .tree-row .tl').first().click();
    const status = page.locator('#panel-mesh-form [data-mesh-status="generating"]');
    await expect(status.locator('.mesh-elapsed')).toHaveText(/^2:00:\d\d$/, { timeout: 30_000 });
  });
});
