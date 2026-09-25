import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Step 2 acceptance (docs/STL-STEP-mesh-handoff.md): the faceted STL of the vortex
// part is grouped into real surfaces, its two ports take pressure BCs, the Standard
// mesh builds, and a steady solve runs the right way: in at the 0 Pa port, out at
// the -15 kPa port, at the same speed through both. Opt-in: a full mesh and a
// 200-iteration solve take tens of minutes.
const HEAVY = process.env.MAGNUSIM_E2E_HEAVY === '1';
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const STL = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry', 'elbow.stl');

// Both meshers the app offers: Standard (discrete surfaces, hex core) and Hex-dominant
// (snappyHexMesh, one surface per BC patch).
const MESHERS = [
  { key: 'standard', label: 'Standard mesh' },
  { key: 'snappy_hexdominant', label: 'Hex-dominant mesh' },
];

for (const mesher of MESHERS) {
test(`faceted STL: grouped faces, port BCs, ${mesher.label}, steady solve flows the right way`, async ({ page, request }) => {
  test.skip(!HEAVY || !WSL, 'Requires MAGNUSIM_E2E_HEAVY=1 and MAGNUSIM_E2E_WSL=1');
  test.setTimeout(3_600_000);
  // No action waits forever for an element that is not coming.
  page.setDefaultTimeout(30_000);
  // Progress for whoever watches the run: one STAGE line per change, a heartbeat each
  // minute, and every wait bounded, so a hang shows within a minute or two.
  const t0 = Date.now();
  const stage = (msg) => console.log(`STAGE +${Math.round((Date.now() - t0) / 1000)}s ${msg}`);
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`) }).catch(() => {});
  const waitFor = async (label, probe, { timeout, interval = 5_000, maxErrors = 6 }) => {
    const end = Date.now() + timeout;
    let errors = 0;
    let last = '';
    let beat = Date.now();
    while (Date.now() < end) {
      try {
        const v = await probe();
        errors = 0;
        if (v.log !== last || Date.now() - beat > 60_000) {
          stage(`${label}: ${v.log}`);
          last = v.log;
          beat = Date.now();
        }
        if (v.done) return v;
      } catch (e) {
        errors += 1;
        stage(`${label}: request error ${errors}/${maxErrors} (${String(e.message || e).slice(0, 80)})`);
        if (errors > maxErrors) throw new Error(`${label}: ${errors} request errors in a row`);
      }
      await page.waitForTimeout(interval);
    }
    await shot(`timeout-${label.replace(/\W+/g, '-')}`);
    throw new Error(`${label}: nothing after ${timeout / 1000}s (last: ${last})`);
  };
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(async (title) => {
    const out = await window.__CFD_W16_CREATE__({ title, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
    return out && out.project && out.project.id;
  }, `e2e STL vortex solve ${mesher.key}`);
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  stage(`project ${pid}`);
  await page.locator('#geometry-file-input').setInputFiles(STL);
  await expect(page.locator('#gu-unit')).toBeVisible({ timeout: 15_000 });
  await page.locator('#gu-unit').selectOption('MM');
  await page.locator('#gu-import').click();
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 120_000 });

  stage('imported');
  // Surfaces, not triangles: 4,004 facets make 10 faces, and the ports are flat.
  const meta = await (await request.get(`/api/geometry/cad?project_id=${encodeURIComponent(pid)}&part=preview`)).json();
  expect(meta.n_display_tris).toBe(4004);
  expect(meta.faces.length).toBe(10);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const side = meta.faces.find((f) => near(f.normal[0], 1, 0.01) && near(f.centroid[2], 279.4, 2));
  const top = meta.faces.find((f) => near(f.normal[2], 1, 0.01) && near(f.centroid[2], 304.8, 0.5) && near(f.centroid[0], 0, 1));
  expect(side && side.surface_type).toBe('Plane');
  expect(top && top.surface_type).toBe('Plane');

  stage(`faces ${meta.faces.length}; ports face ${side.id} and ${top.id}`);
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#panel-sim-control .cfd-island [data-run-control="1"]')).toBeVisible({ timeout: 30_000 });
  const study = page.locator('#left-tree [data-w17-sim="1"] > .tree-row').first();
  if ((await study.locator('.tw').textContent())?.trim() === '+') await study.locator('.tw').click();

  // Two pressure BCs, added through the picker like a user, then pointed at the ports.
  const saved = async () =>
    (await (await request.get(`/api/bcs?project_id=${encodeURIComponent(pid)}`)).json()).boundary_conditions || [];
  const ports = [
    { face: side.id, value: 0 },
    { face: top.id, value: -15000 },
  ];
  for (const port of ports) {
    await page.locator('#btn-bcs-plus').click();
    const picker = page.locator('#panel-bc-picker .cfd-island');
    await expect(picker).toBeVisible();
    await picker.locator('[data-bc-key="pressure_outlet"]').click();
    await picker.locator('[data-bc-add="1"]').click();
    const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
    await expect(editor).toBeVisible({ timeout: 15_000 });
    port.name = ((await editor.locator('[data-bc-title="1"]').textContent()) || '').trim();
    const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
    expect(id).toBeTruthy();
    // Wait for the create to land (its reply resets the editor's faces), then put the
    // face on through the same call a viewport click makes, and the value through the editor's.
    await expect.poll(async () => (await saved()).some((x) => x.name === port.name), { timeout: 15_000 }).toBe(true);
    await page.evaluate((face) => window.__CFD_ASSIGN_FACE__(face), port.face);
    await expect
      .poll(async () => ((await saved()).find((x) => x.name === port.name) || {}).faces || [], { timeout: 15_000 })
      .toEqual([`face ${port.face}@Body1`]);
    await page.evaluate(([bcId, value]) => window.__CFD_BC_UPDATE__(bcId, { value, unit: 'Pa' }), [id, port.value]);
    await expect
      .poll(async () => {
        const b = (await saved()).find((x) => x.name === port.name) || {};
        return `${(b.faces || []).join(',')}|${b.value}`;
      })
      .toBe(`face ${port.face}@Body1|${port.value}`);
    await editor.getByRole('button', { name: 'Done' }).click();
    stage(`${port.name}: face ${port.face}, ${port.value} Pa`);
  }

  // Air on the body, as a user does it.
  const air = async () => {
    const r = await request.get(`/api/materials?project_id=${encodeURIComponent(pid)}`).catch(() => null);
    if (!r || !r.ok()) return {};
    return ((await r.json()).materials || []).find((m) => /air/i.test(String(m.name || ''))) || {};
  };
  // A new study has no material yet: Materials + opens the list of bodies; click Body1.
  await page.locator('#left-tree #btn-materials-plus').first().click();
  const matPanel = page.locator('#panel-material-picker .cfd-island, #panel-air-material .cfd-island').first();
  await expect(matPanel).toBeVisible({ timeout: 15_000 });
  if (!((await air()).assigned_volumes || []).includes('Body1')) {
    await matPanel.locator('[data-volume="Body1"] button').first().click();
  }
  await expect.poll(async () => (await air()).assigned_volumes || [], { timeout: 15_000 }).toEqual(['Body1']);
  stage('Air on Body1');
  await shot('1-air');

  // Standard mesh at the defaults (fineness 5, hex core, boundary layers).
  const caseSnap = async () => {
    const r = await request.get(`/api/case?project_id=${encodeURIComponent(pid)}`);
    if (!r.ok()) throw new Error(`/api/case ${r.status()}`);
    return r.json();
  };
  const meshStatus = (c) => c.status || c.live_mesh_result?.status || 'none';
  const before = meshStatus(await caseSnap());
  const meshFolder = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first();
  await meshFolder.locator('.tl').click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible({ timeout: 30_000 });
  if (mesher.key !== 'standard') {
    await form.locator('details.mesh-advanced > summary').click();
    await form.locator('details.mesh-advanced [data-mesh-engine="1"]').selectOption(mesher.key);
    await expect(form.locator('[data-mesh-algorithm="1"]')).toHaveText(/Hex-dominant/i);
    stage(`mesher ${mesher.key}`);
  }
  await shot('2-mesh-form');
  // The server's answer to Generate goes in the log, so a refused job says why.
  page.on('response', async (r) => {
    if (!/\/api\/mesh\/(generate|kick)/.test(r.url())) return;
    const body = await r.text().catch(() => '');
    let why = '';
    try {
      const j = JSON.parse(body);
      why = j.error || j.message || '';
    } catch {
      why = body.replace(/\s+/g, ' ').slice(0, 300);
    }
    stage(`generate response ${r.status()} ${(r.request().postData() || '').slice(0, 300)} -> ${why}`);
  });
  await form.locator('[data-mesh-generate="1"]').click();
  stage(`Generate clicked (case status before: ${before})`);
  const formState = async () => {
    const el = form.locator('[data-mesh-status]').first();
    const attr = await el.getAttribute('data-mesh-status').catch(() => '?');
    const text = ((await el.textContent().catch(() => '')) || '').trim().slice(0, 80);
    return `${attr} "${text}"`;
  };
  // A mesh job must show up within 90 s, or the click did nothing.
  await waitFor(
    'mesh start',
    async () => {
      const c = await caseSnap();
      const st = meshStatus(c);
      const started = /running|queued|done|failed/.test(st) && !!(c.generate_id || c.kick_id || st !== before);
      const form = await formState();
      // The panel already says it failed: stop now, not after the whole wait.
      if (/^failed/.test(form)) throw new Error(`Generate failed: ${form}`);
      return { done: started, log: `case ${st}, form ${form}` };
    },
    { timeout: 90_000, interval: 3_000 },
  );
  await shot('3-mesh-running');
  const meshDone = await waitFor(
    'mesh',
    async () => {
      const c = await caseSnap();
      const st = meshStatus(c);
      return { done: /done|failed/.test(st), log: `${st} ${c.stage || c.live_mesh_result?.stage || ''}`.trim(), c };
    },
    { timeout: 900_000, interval: 5_000 },
  );
  const mesh = meshDone.c;
  expect(meshStatus(mesh), JSON.stringify(mesh.error || mesh.live_mesh_result?.error || '')).toBe('done');
  const caseDir = mesh.case_dir || mesh.live_mesh_result?.case_dir;
  const patchOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (mesher.key === 'standard') {
    const hostLog = readFileSync(join(caseDir, 'log.gmsh_host.txt'), 'utf8');
    expect(hostLog).toMatch(/discrete surfaces/);
    expect(readFileSync(join(caseDir, 'log.standard_generate.txt'), 'utf8')).toMatch(/Mesh OK/);
  } else {
    // snappyHexMesh ran (blockMesh background), not the Standard gmsh path.
    expect(existsSync(join(caseDir, 'log.blockMesh'))).toBe(true);
    expect(existsSync(join(caseDir, 'log.gmsh_host.txt'))).toBe(false);
    // Hex-dominant: every BC is its own patch, typed for the solver.
    const boundary = readFileSync(join(caseDir, 'constant', 'polyMesh', 'boundary'), 'utf8');
    for (const port of ports) expect(boundary).toMatch(new RegExp(`\\b${patchOf(port.name)}\\s*\\{\\s*type\\s+patch;`));
    expect(boundary).toMatch(/\bwalls\s*\{\s*type\s+wall;/);
  }
  stage(`mesh done: ${mesh.n_cells ?? mesh.live_mesh_result?.n_cells} cells`);

  // Steady, 200 iterations, as in the handoff.
  const statusUrl = `/api/run/status?project_id=${encodeURIComponent(pid)}`;
  // The new study already has Run 1: open it (the Simulation row opens the hub).
  await page.locator('#left-tree').getByText('Run 1', { exact: true }).first().click();
  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  await expect(runPanel.locator('[data-run-start]')).toBeVisible({ timeout: 30_000 });
  const iterations = runPanel.getByLabel('Iterations', { exact: true });
  await iterations.fill('200');
  await iterations.press('Enter');
  const writeInterval = runPanel.getByLabel('Write interval', { exact: true });
  await writeInterval.fill('50');
  await writeInterval.press('Enter');
  // If Start stays off, the failure shows the panel's own reason.
  await waitFor(
    'start enabled',
    async () => {
      const on = await runPanel.locator('[data-run-start]').isEnabled();
      const why = on ? '' : await runPanel.locator('[data-run-reason]').textContent().catch(() => '');
      return { done: on, log: on ? 'enabled' : `disabled: ${(why || '').trim()}` };
    },
    { timeout: 60_000, interval: 2_000 },
  );
  await runPanel.locator('[data-run-start]').click();
  await shot('4-started');
  const runSnap = async () => {
    const r = await request.get(statusUrl);
    if (!r.ok()) throw new Error(`run status ${r.status()}`);
    const j = await r.json();
    return j.run || (j.runs || [])[0] || {};
  };
  await waitFor(
    'solve start',
    async () => {
      const rs = await runSnap();
      return { done: /running|done|failed|stopped/.test(rs.status || ''), log: rs.status || 'none' };
    },
    { timeout: 90_000, interval: 3_000 },
  );
  const finished = await waitFor(
    'solve',
    async () => {
      const rs = await runSnap();
      const it = rs.iteration ?? rs.progress?.iteration ?? rs.last_time ?? rs.progress?.time ?? '';
      return { done: /done|failed|stopped/.test(rs.status || ''), log: `${rs.status} ${it}`.trim(), rs };
    },
    { timeout: 2_400_000, interval: 10_000 },
  );
  const run = finished.rs;
  expect(run.status, JSON.stringify(run.log_excerpt || '').slice(-1500)).toBe('done');

  // Last area-averaged velocity on each port patch.
  const log = readFileSync(join(run.case_dir, 'log.simpleFoam'), 'utf8');
  const lastU = (patch) => {
    const re = new RegExp(`areaAverage\\(${patch}\\) of U = \\(([^)]+)\\)`, 'g');
    let m;
    let last = null;
    while ((m = re.exec(log))) last = m[1].trim().split(/\s+/).map(Number);
    return last;
  };
  const [p1, p2] = ports.map((p) => lastU(patchOf(p.name)));
  expect(p1, `no areaAverage(${patchOf(ports[0].name)}) of U in log.simpleFoam`).toBeTruthy();
  expect(p2, `no areaAverage(${patchOf(ports[1].name)}) of U in log.simpleFoam`).toBeTruthy();
  const dot = (u, n) => u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
  const in1 = -dot(p1, side.normal);
  const out2 = dot(p2, top.normal);
  const summary = `in ${in1.toFixed(2)} m/s at 0 Pa, out ${out2.toFixed(2)} m/s at -15 kPa`;
  test.info().annotations.push({ type: 'ports', description: summary });
  console.log(`ports: ${summary}`);
  // In through the 0 Pa port, out through the -15 kPa port, same order of speed
  // (the STEP reference is ~97 m/s both ways; the faceted part will not match it exactly).
  expect(in1).toBeGreaterThan(30);
  expect(out2).toBeGreaterThan(30);
  expect(in1 / out2).toBeGreaterThan(0.5);
  expect(in1 / out2).toBeLessThan(2);
});
}
