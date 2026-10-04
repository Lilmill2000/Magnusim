import { expect, test } from '@playwright/test';
import { MESH_FORM_PROJECT as PID } from './prepare-projects.js';

// A mesh's settings form loads the mesh's stored settings after it opens. A field the
// user changed before that load landed was set back to the stored value, so Generate
// meshed with settings the user had not chosen (h10-ui-parity typed fineness 1 into a
// new mesh and sometimes generated fineness 5). And a change saved before the load
// wrote the form's defaults over the stored settings the user had not touched.
// Here the form's read of the stored settings is answered at once and delivered late,
// so the user's edit always comes first: the form keeps the typed fineness, shows the
// stored value of a field the user did not touch, saves both, and Generate sends them.
const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: PID, ...extra })}`;

/** Before the load lands the user's change is (or is not yet) saved: both orders. */
for (const [when, pause] of [
  ['before its change is saved', 0],
  ['after its change would have been saved', 1_200],
]) {
  test(`a fineness typed while the mesh settings load is kept when the load lands ${when}, and Generate uses it`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(30_000);
    const tree = await (await request.get(q('/api/project/tree'))).json();
    const study = (tree.geometries || []).flatMap((g) => g.studies || [])[0] || {};
    const meshId = String(((study.meshes || [])[0] || {}).id || '');
    expect(meshId, 'seeded mesh').toBeTruthy();
    const sid = String(study.id || '');

    // Stored: fineness 5 with Hex element core off (the form's defaults have it on).
    const saved = await request.post('/api/mesh', {
      data: { project_id: PID, simulation_id: sid, mesh_id: meshId, fineness: 5, hex_element_core: false },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    const stored = async () =>
      ((await (await request.get(q('/api/mesh', { simulation_id: sid, mesh_id: meshId }))).json()).mesh || {}).settings ||
      {};
    expect(await stored()).toMatchObject({ fineness: 5, hex_element_core: false });

    await page.goto(`/#/p/${encodeURIComponent(PID)}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');

    // The form's read of this mesh is answered now and handed over when the test says.
    let release = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    let held = 0;
    const hold = async (route) => {
      const req = route.request();
      if (req.method() !== 'GET' || !new URL(req.url()).searchParams.get('mesh_id')) return route.fallback();
      held += 1;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    };
    await page.route(/\/api\/mesh(\?|$)/, hold);
    // Generate is refused before it starts: only what it asked for matters here.
    const generates = [];
    await page.route(/\/api\/mesh\/generate(\?|$)/, async (route) => {
      generates.push(route.request().postDataJSON());
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, final: true, error: 'Generate held by the test.' }),
      });
    });

    try {
      await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
      const form = page.locator('#panel-mesh-form .cfd-island');
      const fineness = form.locator('[data-schema-key="fineness"] input');
      const hex = form.locator('button[aria-label="Hex element core"]');
      await expect(fineness).toBeVisible();
      await expect.poll(() => held, 'the form asked for the stored settings').toBe(1);
      await fineness.fill('2');
      await expect(fineness).toHaveValue('2');
      if (pause) await page.waitForTimeout(pause);

      // The stored settings (fineness 5, no hex core) land.
      const landed = page.waitForResponse(
        (r) => r.request().method() === 'GET' && !!new URL(r.url()).searchParams.get('mesh_id'),
      );
      release();
      await landed;
      // What the form shows from then on, read every 100 ms for 2 s: never the stored 5.
      const seen = [];
      for (let i = 0; i < 20; i++) {
        seen.push(`${await fineness.inputValue()}/${await hex.getAttribute('aria-pressed')}`);
        await page.waitForTimeout(100);
      }
      expect(new Set(seen), 'fineness / hex core shown after the load landed').toEqual(new Set(['2/false']));
      await expect
        .poll(stored, 'the typed fineness is saved, the untouched hex core stays off')
        .toMatchObject({ fineness: 2, hex_element_core: false });

      await form.locator('[data-mesh-generate="1"]').click();
      await expect.poll(() => generates.length, 'Generate was asked for').toBe(1);
      expect(generates[0].mesh_id).toBe(meshId);
      expect(generates[0].settings, 'Generate meshes with what the form shows').toMatchObject({
        fineness: 2,
        hex_element_core: false,
      });
      await expect(form.getByRole('alert')).toContainText('Generate held by the test.');
      await expect(fineness).toHaveValue('2');
      await expect(hex).toHaveAttribute('aria-pressed', 'false');
    } finally {
      release();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });
}
