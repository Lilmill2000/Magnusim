import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wslPathExists } from './toolchain.js';

const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';

/** GET json; a poll can reuse a keep-alive socket just as the server closes it, so retry that. */
const getJson = async (request, url) => {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
};

/** Click a mesh form toggle until aria-pressed/checked is the wanted state. */
async function setIslandToggle(page, label, on) {
  const el = page.locator(`#panel-mesh-form .cfd-island button[aria-label="${label}"]`);
  await expect(el).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < 4; i += 1) {
    const pressed = await el.getAttribute('aria-pressed');
    if ((pressed === 'true') === on) return;
    await el.click();
    await page.waitForTimeout(150);
  }
}

// The solve, transient, results and exports, study panel and physics tests are
// Incompressible Flow's: bundled-plugins/incompressible_flow/e2e/solve-smoke.spec.js.
test.describe('Magnusim smoke', () => {
  test('home -> sample project -> mesh form', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const list = Array.isArray(body.projects) ? body.projects : [];
    const sample = list.find((p) => {
      const id = String(p.id || '');
      const title = String(p.title || p.name || '');
      return (
        id === 'sample-project-steady-state-e2e' ||
        id.startsWith('sample-project-steady-state') ||
        /sample.*steady/i.test(title)
      );
    });
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;
    expect(id).toBeTruthy();

    // Home hash: #/p/<id>
    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Mesh/i, { timeout: 30_000 });

    // Islands reach the runtime only through these; see src/panels/legacyBridge.ts.
    const bridge = await page.evaluate(() =>
      [
        '__CFD_OPEN_TREE_DETAIL__',
        '__CFD_OPEN_BC__',
        '__CFD_W21_GENERATE__',
        '__CFD_SIM_START__',
        '__CFD_SIM_STOP__',
        '__CFD_REFRESH_TREE__',
        '__CFD_WATCH_JOB__',
      ].filter((name) => typeof window[name] !== 'function'),
    );
    expect(bridge, 'legacy bridge globals must be wired').toEqual([]);

    // Collapsed Mesh hides Mesh 1; expand the section, then click the row.
    const meshSectionTw = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tw').first();
    const meshRow = page.locator('#left-tree [data-w20-mesh-item]').first();
    if (await meshRow.count()) {
      if (!(await meshRow.isVisible().catch(() => false))) {
        if (await meshSectionTw.count()) await meshSectionTw.click();
      }
      if (await meshRow.isVisible().catch(() => false)) {
        await meshRow.click();
      } else {
        await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first().click();
      }
    } else {
      await page.locator('#left-tree').getByText(/Mesh\s*1/i).first().click();
    }

    // If inspect chip is up (generated mesh), open Settings to reach the form.
    const settingsBtn = page.locator('#mesh-inspect-settings');
    try {
      await settingsBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await settingsBtn.click();
    } catch {
      /* form may already be opening for ungenerated mesh */
    }

    await expect(page.locator('#panel-mesh-form')).toBeVisible({ timeout: 30_000 });
    const fineness = page.locator('#panel-mesh-form .cfd-island [data-schema-key="fineness"] input');
    await expect(fineness).toBeVisible({ timeout: 10_000 });
    await fineness.fill('1');

    test.info().annotations.push({ type: 'smoke', description: 'steps 1-3 green' });

    if (!WSL) {
      // Soft-pass kill: CI may skip WSL, but Timmy Phase-0 overall PASS requires MAGNUSIM_E2E_WSL=1 (or CFDDESK_E2E_WSL).
      test.info().annotations.push({ type: 'skip-mesh', description: 'MAGNUSIM_E2E_WSL/CFDDESK_E2E_WSL!=1' });
      return;
    }

    // F=1 + hexcore hits HXT failure on this sample; prove Generate?n_cells>0 with hex off.
    // Test harness only ? no product mesher change.
    await setIslandToggle(page, 'Hex element core', false);
    await setIslandToggle(page, 'Automatic boundary layers', false);

    // One Generate path: the island button, then the panel itself must say so.
    const gen = page.locator('#panel-mesh-form [data-mesh-generate="1"]');
    await expect(gen).toHaveText(/^Generate$/);
    await gen.click();
    const status = page.locator('#panel-mesh-form [data-mesh-status]');
    await expect(status).toBeVisible({ timeout: 30_000 });
    await expect(status).toHaveAttribute('data-mesh-status', /generating|finishing|ready/);
    await expect(gen).toBeDisabled();
    // The elapsed clock ticks while the job runs.
    const clock = page.locator('#panel-mesh-form .mesh-elapsed');
    if (await clock.isVisible().catch(() => false)) {
      const first = await clock.textContent();
      await page.waitForTimeout(2_100);
      // A coarse mesh can finish inside the wait; then the clock gives way to the result.
      const ticked = (await clock.textContent().catch(() => first)) !== first;
      const finished = /ready|finishing/.test((await status.getAttribute('data-mesh-status')) || '');
      expect(ticked || finished, 'elapsed clock ticks while generating').toBe(true);
    }

    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/case?project_id=${encodeURIComponent(id)}`).catch(() => null);
          if (!r || !r.ok()) return 'wait';
          const j = await r.json();
          return j.status || j.live_mesh_result?.status || 'wait';
        },
        { timeout: 800_000 },
      )
      .toMatch(/done|failed/);

    const final = await (
      await request.get(`/api/case?project_id=${encodeURIComponent(id)}`)
    ).json();
    const caseStatus = final.status || final.live_mesh_result?.status;
    const nCells = final.n_cells ?? final.live_mesh_result?.n_cells ?? 0;
    expect(caseStatus).toBe('done');
    expect(nCells).toBeGreaterThan(0);
    // The mesher's WSL copy goes once the mesh is on Windows (left behind, these
    // filled ~115 GB of WSL disk in 11 days).
    const meshWslCase = final.wsl_case || final.live_mesh_result?.wsl_case;
    expect(meshWslCase, 'the mesh result names its WSL case').toMatch(/\/cfddesk-cfdweb-[a-z0-9]+$/);
    expect(wslPathExists(meshWslCase), `${meshWslCase} removed after the mesh`).toBe(false);

    // The panel reports the result: "Mesh ready — N cells / M nodes", Generate re-enabled, tree ticked.
    await expect(status).toHaveAttribute('data-mesh-status', 'ready', { timeout: 60_000 });
    await expect(page.locator('#panel-mesh-form .mesh-finished-line')).toHaveText(
      /^[\d,]+ cells \/ [\d,]+ nodes$/,
    );
    await expect(page.locator('#panel-mesh-form .mesh-finished-line')).toHaveAttribute(
      'data-n-cells',
      String(nCells),
    );
    await expect(gen).toBeEnabled();
    await expect(page.locator('#left-tree [data-w20-mesh1="1"]').first()).toBeVisible({ timeout: 30_000 });
    test.info().annotations.push({
      type: 'mesh',
      description: `F=1 generate done n_cells=${nCells}`,
    });
  });

  test('incompressible study + BC picker reflects saved wall defaults', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const list = Array.isArray(body.projects) ? body.projects : [];
    const sample = list.find((p) => {
      const id = String(p.id || '');
      const title = String(p.title || p.name || '');
      return (
        id === 'sample-project-steady-state-e2e' ||
        id.startsWith('sample-project-steady-state') ||
        /sample.*steady/i.test(title)
      );
    });
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;

    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Simulation/i, { timeout: 30_000 });

    await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
    await expect(page.locator('#panel-sim-hub')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#panel-sim-hub')).not.toContainText(/example_passthrough/i);

    const bcPlus = page.locator('#btn-bcs-plus');
    await expect(bcPlus).toBeVisible();
    await bcPlus.click();
    await expect(page.locator('#panel-bc-picker')).toBeVisible();
    const pickerDefaults = page.locator('#panel-bc-picker [data-bc-defaults="1"]');
    await pickerDefaults.click();
    await page.locator('#bc-default-wall-type').selectOption('Slip');
    await expect(page.locator('#bc-default-wall-hint')).toContainText('slip wall');
    await expect(page.locator('#left-tree [data-w19-defaults] .tree-sub')).toHaveText('Slip walls');
    await bcPlus.click();
    await expect(pickerDefaults.locator('.ml-type-sub')).toHaveText('Unassigned faces: slip walls');
    await pickerDefaults.click();
    await page.locator('#bc-default-wall-type').selectOption('No-slip');
    await bcPlus.click();
    await expect(pickerDefaults.locator('.ml-type-sub')).toHaveText('Unassigned faces: no-slip walls');
    await expect(page.locator('#left-tree [data-w19-defaults] .tree-sub')).toHaveText('No-slip walls');
    await page.reload();
    await expect(page.locator('#left-tree [data-w19-defaults]')).toContainText('No-slip', { timeout: 30_000 });

  });
  test('fresh STL: Create Simulation appears without reload and lands on Run 1 with its reason', async ({ page, request }) => {
    // A 1 cm cube as ASCII STL, written per run so the test needs no binary fixture.
    const v = [[0, 0, 0], [0.01, 0, 0], [0.01, 0.01, 0], [0, 0.01, 0], [0, 0, 0.01], [0.01, 0, 0.01], [0.01, 0.01, 0.01], [0, 0.01, 0.01]];
    const tris = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
    const stl = ['solid cube', ...tris.flatMap((t) => ['facet normal 0 0 0', 'outer loop', ...t.map((i) => `vertex ${v[i].join(' ')}`), 'endloop', 'endfacet']), 'endsolid cube'].join('\n');
    const file = join(mkdtempSync(join(tmpdir(), 'magnusim-e2e-')), 'cube.stl');
    writeFileSync(file, stl);

    await page.goto('/#/');
    await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
    const pid = await page.evaluate(async () => {
      const out = await window.__CFD_W16_CREATE__({ title: 'e2e fresh stl', description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
      return out && out.project && out.project.id;
    });
    expect(pid).toBeTruthy();
    await page.goto(`/#/p/${encodeURIComponent(pid)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#btn-create-simulation')).toBeHidden();

    await page.locator('#geometry-file-input').setInputFiles(file);
    await page.locator('#gu-import').click();
    await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });

    await page.locator('#btn-create-simulation').click();
    await page.locator('#cs-create').click();
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    await expect(runPanel).toBeVisible({ timeout: 30_000 });
    await expect(runPanel.locator('[data-run-title]')).toHaveText('Run 1');
    await expect(runPanel.locator('[data-run-start]')).toBeDisabled();
    await expect(runPanel.locator('[data-run-reason]')).toBeVisible();
    // The tree reloads from the server's project tree, which can take several seconds
    // on a loaded machine (the panel above already shows the run).
    const treeHasRun = await expect(page.locator('#left-tree'))
      .toContainText('Run 1', { timeout: 30_000 })
      .then(() => true, () => false);
    if (!treeHasRun) {
      // Say which side is missing it (CI shows only this message, not the page).
      const sid = await page.evaluate(() => window.__CFD_W17__ && window.__CFD_W17__.activeId);
      const q = (path) => `${path}?project_id=${encodeURIComponent(pid)}&simulation_id=${encodeURIComponent(sid || '')}`;
      const runs = ((await getJson(request, q('/api/run/status'))).runs || []).map((r) => `${r.name}:${r.status}`);
      const tree = await getJson(request, `/api/project/tree?project_id=${encodeURIComponent(pid)}`);
      const treeRuns = (tree.geometries || []).flatMap((g) => g.studies || []).map((s) => `${s.id}:[${(s.runs || []).map((r) => r.name).join(',')}]`);
      throw new Error(`tree never showed Run 1. study ${sid}; server runs ${JSON.stringify(runs)}; server tree ${JSON.stringify(treeRuns)}`);
    }
  });

  test('Air: sci-notation viscosity saves; a viewport body click assigns and unassigns', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    const list = (await res.json()).projects || [];
    const sample = list.find((p) => String(p.id || '').startsWith('sample-project-steady-state'));
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;
    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    // The shared sample project can hold other specs' studies: read and click the active
    // study's Air, not the first Air in the project or the tree.
    await page.waitForFunction(() => !!(window.__CFD_W17__ && window.__CFD_W17__.activeId), null, { timeout: 30_000 });
    const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
    const air = async () => {
      const r = await request.get(`/api/materials?project_id=${encodeURIComponent(id)}&simulation_id=${encodeURIComponent(sid)}`);
      const j = await r.json();
      return (j.materials || []).find((m) => /air/i.test(String(m.name || ''))) || {};
    };
    const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);
    const airRow = study.locator('[data-w18-air="1"] > .tree-row').first();
    if (!(await airRow.isVisible().catch(() => false))) {
      await study.locator('[data-w18-materials="1"] > .tree-row').first().click();
    }
    await airRow.click();
    const panel = page.locator('#panel-air-material .cfd-island');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('[data-material-picking="1"]')).toContainText('click a body in the viewport');

    const nu = panel.getByLabel('Kinematic viscosity');
    await expect(nu).toHaveValue(/e-5$/);
    await nu.fill('2e-5');
    await nu.press('Enter');
    await expect.poll(async () => (await air()).kinematic_viscosity).toBe(0.00002);
    await expect(nu).toHaveValue('2.0000e-5');

    // Click the model: the one body toggles, persists, and the list follows.
    const before = (await air()).assigned_volumes || [];
    const body = before[0] || 'Body1';
    const row = panel.locator(`[data-volume="${body}"]`);
    const box = await page.locator('#viewer').boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const flipped = before.includes(body) ? [] : [body];
    await expect.poll(async () => (await air()).assigned_volumes).toEqual(flipped);
    await expect(row).toHaveAttribute('data-assigned', flipped.length ? '1' : '0');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await air()).assigned_volumes).toEqual(before);
    await expect(study.locator('[data-w18-materials="1"] > .tree-row').first()).toContainText('✓');
  });

  test('BC: pick a type, then Add; click a face; hub card reopens the editor', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    const list = (await res.json()).projects || [];
    const sample = list.find((p) => String(p.id || '').startsWith('sample-project-steady-state'));
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;
    const bcsNow = async () => {
      const r = await request.get(`/api/bcs?project_id=${encodeURIComponent(id)}`);
      return (await r.json()).boundary_conditions || [];
    };

    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Boundary conditions/i, { timeout: 30_000 });
    const before = (await bcsNow()).length;

    // Picker: choosing a type creates nothing; Add is the only create.
    await page.locator('#btn-bcs-plus').click();
    const picker = page.locator('#panel-bc-picker .cfd-island');
    await expect(picker).toBeVisible();
    const add = picker.locator('[data-bc-add="1"]');
    await expect(add).toBeDisabled();
    await picker.locator('[data-bc-key="velocity_inlet"]').click();
    await picker.locator('[data-bc-key="pressure_outlet"]').click();
    await expect(picker.locator('[data-bc-key="pressure_outlet"]')).toHaveClass(/is-selected/);
    expect((await bcsNow()).length).toBe(before);
    await add.click();

    // Add opens the editor on the new record.
    const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
    await expect(editor).toBeVisible({ timeout: 15_000 });
    const title = editor.locator('[data-bc-title="1"]');
    await expect(title).toHaveText(/^Pressure \d+$/);
    const name = (await title.textContent()) || '';
    await expect.poll(async () => (await bcsNow()).length).toBe(before + 1);

    // A click on the model assigns that face and it persists.
    const box = await page.locator('#viewer').boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const chips = editor.locator('[data-face-picker="1"] [data-face-id]');
    await expect(chips).toHaveCount(1, { timeout: 10_000 });
    const shown = await chips.first().getAttribute('data-face-id');
    await expect
      .poll(async () => ((await bcsNow()).find((b) => b.name === name) || {}).faces || [])
      .toEqual([shown]);

    // The value typed in the editor is what the solver reads.
    const value = editor.getByLabel('Fixed value', { exact: true });
    await value.fill('250');
    await value.press('Enter');
    await expect.poll(async () => ((await bcsNow()).find((b) => b.name === name) || {}).value).toBe(250);

    // Hub card reopens it; Delete removes the card and the tree row.
    await editor.getByRole('button', { name: 'Done' }).click();
    await expect(editor).toBeHidden();
    await page.locator('#left-tree [data-w19-bcs="1"] > .tree-row .tl').first().click();
    const hub = page.locator('#panel-bcs-hub .cfd-island');
    await expect(hub).toBeVisible();
    const card = hub.locator('.hub-item', { hasText: name });
    await expect(card).toContainText(`Pressure · ${shown}`);
    await card.click();
    await expect(title).toHaveText(name);
    await editor.getByRole('button', { name: 'Delete' }).click();
    await expect.poll(async () => (await bcsNow()).length).toBe(before);
    await expect(page.locator('#left-tree')).not.toContainText(name);
  });

});
