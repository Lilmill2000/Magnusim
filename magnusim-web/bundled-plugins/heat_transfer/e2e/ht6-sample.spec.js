// Heat Transfer (HT6): the heat-sink sample (manifest [[samples]], host API 1.8), copied as a
// new project the way the app does it (POST /api/project/sample: the Assistant's "open the heat
// sink sample"; Home has no Open sample button since v0.5.0) and opened.
// - The copy opens: the study is conjugate heat transfer (Body2 aluminium, a
//   10 W heat source), the BCs and the Hex-dominant mesh settings are there, Generate is
//   offered, and a draft run waits. The copy names its own folder everywhere (no
//   placeholder, no other project's path). After a reload, the same.
// - A second copy is "Heat sink 2", with a run of its own (a run's id names its WSL case).
// - With WSL: the sample meshed (Hex-dominant) and solved with its run as it comes (1500
//   iterations, Heat Transfer's steady default); the energy balance carries the 10 W out
//   within 3 %.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL, expect, test } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', '..', '..');
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT || resolve(WEB, 'e2e', '.tmp-projects');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const CHT_LINE = 'Conjugate heat transfer with chtMultiRegionSimpleFoam: Body2 is Aluminium 6061 (solid). Body1 is Air (fluid).';

async function json(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

/** Every JSON file's text under `dir`. */
function jsonTexts(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...jsonTexts(path));
    else if (name.endsWith('.json')) out.push([path, readFileSync(path, 'utf8')]);
  }
  return out;
}

/** Every string in a JSON value that is an absolute path (a drive letter, or '/' but not a URL). */
function pathStrings(value) {
  if (typeof value === 'string') return /^[A-Za-z]:[\\/]/.test(value) || /^\/(?!api\/)/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(pathStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(pathStrings);
  return [];
}

/** The heat-sink sample copied as a new project (the app's sample route) and opened: its id. */
async function openSample(page) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const made = await page.evaluate(async () => {
    const r = await fetch('/api/project/sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin: 'heat_transfer', sample: 'heat-sink' }) });
    return { status: r.status, body: await r.json() };
  });
  expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
  const pid = String(made.body.id);
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  return pid;
}

/** The opened sample: its study, records and helpers. */
async function sampleStudy(page, request, pid) {
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const sims = (await json(request, q('/api/simulation'))).simulations || [];
  expect(sims.map((s) => s.analysis_type)).toEqual(['heat_transfer_steady']);
  const sid = sims[0].id;
  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);
  await expect(studyRow).toBeVisible({ timeout: 60_000 });
  return { pid, sid, q, studyRow };
}

async function openStudy(page, s) {
  const panel = page.locator('#panel-study-settings .cfd-island');
  if (!(await panel.isVisible())) await s.studyRow.locator(':scope > .tree-row').first().click();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** What a user sees of the opened sample, and what it saved. */
async function checkSample(page, request, s) {
  const panel = await openStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 30_000 });
  const mats = (await json(request, s.q('/api/materials', { simulation_id: s.sid }))).materials || [];
  const al = mats.find((m) => m.material_model === 'thermo_solid');
  expect(mats.map((m) => `${m.name}:${(m.assigned_volumes || []).join()}`).sort()).toEqual(['Air:Body1', 'Aluminium 6061:Body2']);
  await expect(panel.locator(`[data-ht-heat-source="${al.id}"] [data-ht-heat-source-value]`)).toHaveText('10 W');
  // Gravity along -Y (the channel's floor is y = 0), as the sample was made.
  await expect(panel.locator('[data-schema-key="gravity"] select option:checked')).toHaveText('−Y (down along Y)');
  const bcs = (await json(request, s.q('/api/bcs', { simulation_id: s.sid }))).boundary_conditions || [];
  expect(bcs.map((b) => `${b.name}:${b.bc_type}`).sort()).toEqual(['Inlet:Velocity inlet', 'Outlet:Pressure']);
  // The mesh: Hex-dominant, fineness 4, not generated; Generate offered.
  const meshes = (await json(request, s.q('/api/mesh', { simulation_id: s.sid }))).meshes || [];
  expect(meshes.length).toBe(1);
  expect(meshes[0].settings.advanced.mesh_engine).toBe('snappy_hexdominant');
  expect(meshes[0].settings.fineness).toBe(4);
  expect(meshes[0].live_mesh_result || null).toBeNull();
  await page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] [data-w20-mesh-item="${meshes[0].id}"] > .tree-row .tl`).first().click();
  const generate = page.locator('#panel-mesh-form .cfd-island [data-mesh-generate="1"]');
  await expect(generate).toHaveText('Generate', { timeout: 30_000 });
  await expect(generate).toBeEnabled();
  await expect(page.locator('#panel-mesh-form .cfd-island select[data-mesh-engine="1"]')).toHaveValue('snappy_hexdominant');
  // A draft run of its own, on that mesh.
  const runs = (await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || [];
  expect(runs.map((r) => [r.status, r.mesh_id])).toEqual([['draft', meshes[0].id]]);
  // Heat Transfer's steady default: 1500 iterations (the sample's heat settles by then).
  expect(Number(runs[0].endTime)).toBe(1500);
  await expect(page.locator(`#left-tree [data-w27-run="${runs[0].id}"]`)).toBeVisible();
  return { meshes, runs, al };
}

test('the heat-sink sample opens as a new project: conjugate heat transfer, a 10 W source, BCs and a Hex-dominant mesh ready to generate; after a reload', async ({ page, request }) => {
  test.setTimeout(300_000);
  const pid = await openSample(page);
  const s = await sampleStudy(page, request, pid);
  const project = (await json(request, s.q('/api/project'))).project;
  expect(project.title).toMatch(/^Heat sink( \d+)?$/);
  expect(project.sample).toEqual({ plugin: 'heat_transfer', key: 'heat-sink' });
  await expect(page.locator('#app .project-name').first()).toHaveText(project.title);
  const first = await checkSample(page, request, s);

  // The copy names its own folder: no placeholder left; every path it holds is in this
  // projects folder, and its mesh's case folder in its own.
  const dir = join(PROJECTS, pid);
  for (const [path, text] of jsonTexts(dir)) {
    expect(text.includes('{{'), path).toBe(false);
    for (const value of pathStrings(JSON.parse(text))) expect(resolve(value).startsWith(resolve(PROJECTS)), `${path}: ${value}`).toBe(true);
  }
  const meshJson = jsonTexts(dir).find(([path]) => /[\\/]meshes[\\/][^\\/]+[\\/]mesh\.json$/.test(path));
  expect(resolve(JSON.parse(meshJson[1]).case_dir).startsWith(resolve(dir))).toBe(true);

  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  await checkSample(page, request, s);

  // A second copy: its own title and its own run.
  const pid2 = await openSample(page);
  expect(pid2).not.toBe(pid);
  const s2 = await sampleStudy(page, request, pid2);
  const title2 = (await json(request, s2.q('/api/project'))).project.title;
  expect(title2).not.toBe(project.title);
  expect(title2).toMatch(/^Heat sink \d+$/);
  const second = await checkSample(page, request, s2);
  expect(second.runs[0].id).not.toBe(first.runs[0].id);
});

test('WSL: the heat-sink sample meshed (Hex-dominant) and solved as it comes (1500 iterations); the energy balance carries its 10 W out', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(2_400_000);
  page.setDefaultTimeout(60_000);
  const pid = await openSample(page);
  const s = await sampleStudy(page, request, pid);
  const { meshes, runs } = await checkSample(page, request, s);
  const meshesNow = async () => (await json(request, s.q('/api/mesh', { simulation_id: s.sid }))).meshes || [];
  await page.locator('#panel-mesh-form .cfd-island [data-mesh-generate="1"]').click();
  await expect
    .poll(async () => {
      const r = ((await meshesNow())[0] || {}).live_mesh_result || {};
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 1_200_000, intervals: [5_000] })
    .toBe('done ');
  const done = (await meshesNow())[0].live_mesh_result;
  expect((done.regions || []).map((r) => [r.name, r.role])).toEqual([['air', 'fluid'], ['aluminium_6061', 'solid']]);
  expect(meshes[0].id).toBe((await meshesNow())[0].id);

  // Its run as it comes: Start.
  const rid = runs[0].id;
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] li[data-w27-sim-control="1"]`).first();
  if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) await runsFolder.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  const start = page.locator('#panel-sim-control .cfd-island [data-run-control="1"] [data-run-start]');
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();
  const runRow = async () => ((await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || []).find((r) => String(r.id) === rid) || {};
  await expect
    .poll(async () => {
      const r = await runRow();
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 1_500_000, intervals: [10_000] })
    .toBe('done ');
  const answer = await json(request, s.q('/api/run/monitors', { simulation_id: s.sid, run_id: rid }));
  expect(answer.summary.map((i) => i.label)).toEqual(['Heat in', 'out', 'imbalance']);
  expect(Number(answer.summary[0].value)).toBeCloseTo(10, 6);
  const body = (answer.monitors || []).find((r) => r.region) || {};
  console.log(
    `[ht6 wsl] heat-sink sample: ${done.n_cells} cells, ${(await runRow()).last_saved_iteration} iterations, ` +
      `${answer.summary.map((i) => `${i.label} ${Number(i.value).toFixed(4)}`).join(', ')}, sink T_max ` +
      `${body.last ? (Number(body.last.T_max_K) - 273.15).toFixed(2) : '?'} °C`,
  );
  expect(Math.abs(Number(answer.summary[2].value))).toBeLessThan(3);
  const monitors = page.locator('#panel-sim-control .cfd-island [data-run-monitors="1"]');
  if (!(await monitors.isVisible())) await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  await expect(monitors).toContainText(/Energy balance · Heat in 10(\.0+)? W · Heat out \d/, { timeout: 60_000 });
});
