import { test, expect } from '@playwright/test';

const WSL = process.env.CFDDESK_E2E_WSL === '1';

test.describe('CFD Desk smoke', () => {
  test('home -> sample project -> mesh form', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const projects = body.projects || body.items || body || [];
    const list = Array.isArray(projects) ? projects : [];
    const sample = list.find((p) =>
      String(p.title || p.name || p.id || '').startsWith('sample-project-steady-state'),
    );
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;
    expect(id).toBeTruthy();

    await page.goto(`/#/project/${id}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Mesh/i, { timeout: 30_000 });

    // Open Mesh 1 tree item
    const meshItem = page.locator('#left-tree').getByText(/Mesh\s*1/i).first();
    await meshItem.click();
    await expect(page.locator('#mesh-fineness')).toBeVisible({ timeout: 30_000 });
    await page.locator('#mesh-fineness').fill('1');

    test.info().annotations.push({ type: 'smoke', description: 'steps 1-3 green' });

    if (!WSL) {
      test.info().annotations.push({ type: 'skip-mesh', description: 'CFDDESK_E2E_WSL!=1' });
      return;
    }

    const gen = page.getByRole('button', { name: /Generate/i }).first();
    await gen.click();
    await expect.poll(async () => {
      const r = await request.get(`/api/case?project_id=${encodeURIComponent(id)}`);
      if (!r.ok()) return 'wait';
      const j = await r.json();
      return j.status || j.live_mesh_result?.status || 'wait';
    }, { timeout: 800_000 }).toMatch(/done|failed/);

    const final = await (await request.get(`/api/case?project_id=${encodeURIComponent(id)}`)).json();
    const status = final.status || final.live_mesh_result?.status;
    const nCells = final.n_cells ?? final.live_mesh_result?.n_cells ?? 0;
    expect(status).toBe('done');
    expect(nCells).toBeGreaterThan(0);
  });
});
