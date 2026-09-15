import { test, expect } from '@playwright/test';

const WSL = process.env.CFDDESK_E2E_WSL === '1';

test.describe('CFD Desk smoke', () => {
  test('home -> sample project -> mesh form', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const list = Array.isArray(body.projects) ? body.projects : [];
    const sample = list.find((p) => {
      const id = String(p.id || '');
      const title = String(p.title || p.name || '');
      return (
        id.startsWith('sample-project-steady-state') ||
        /sample.*steady/i.test(title)
      );
    });
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;
    expect(id).toBeTruthy();

    // dashboard.js parseHomeRoute: #/p/<id>
    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Mesh/i, { timeout: 30_000 });

    // Prefer concrete mesh row; generated meshes open inspect first.
    const meshRow = page.locator('#left-tree [data-w20-mesh-item]').first();
    if (await meshRow.count()) {
      await meshRow.click();
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
    await expect(page.locator('#mesh-fineness')).toBeVisible({ timeout: 10_000 });
    await page.locator('#mesh-fineness').fill('1');

    test.info().annotations.push({ type: 'smoke', description: 'steps 1-3 green' });

    if (!WSL) {
      test.info().annotations.push({ type: 'skip-mesh', description: 'CFDDESK_E2E_WSL!=1' });
      return;
    }

    const gen = page.getByRole('button', { name: /Generate/i }).first();
    await gen.click();
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/case?project_id=${encodeURIComponent(id)}`);
          if (!r.ok()) return 'wait';
          const j = await r.json();
          return j.status || j.live_mesh_result?.status || 'wait';
        },
        { timeout: 800_000 },
      )
      .toMatch(/done|failed/);

    const final = await (
      await request.get(`/api/case?project_id=${encodeURIComponent(id)}`)
    ).json();
    const status = final.status || final.live_mesh_result?.status;
    const nCells = final.n_cells ?? final.live_mesh_result?.n_cells ?? 0;
    expect(status).toBe('done');
    expect(nCells).toBeGreaterThan(0);
  });
});