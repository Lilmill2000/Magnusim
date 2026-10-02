import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEOMETRY_REMOVE_IDS, GEOMETRY_REMOVE_PROJECT, NO_GEOMETRY_PROJECT } from './prepare-projects.js';
import { WEB_ROOT, startHost } from './support/host-server.mjs';
import { PYTHON } from '../scripts/python-env.js';

// H15, a plugin case's results in 3D (gate:h15-attach-scope, UI half, and results.openIn3D),
// with no WSL: the committed finished cavity case (python/tests/fixtures/foam-results/
// cavity-2d) is copied into a Foam demo study. Attach is scoped to the plugin study; the
// workspace's Open in 3D closes it and shows the frames in the project's viewer with no core
// study active, Views and Compare hidden, the case at its own scale and p in Pa (rho 1000);
// a second open asks first; a study click while one loads wins; picking a geometry closes
// them; a reload shows none. A second app server with the Foam demo fixture plugin.
const PROJECT = GEOMETRY_REMOVE_PROJECT;
const KEY = 'foam-demo';
const FIXTURE = join(WEB_ROOT, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PY_DIR = join(WEB_ROOT, 'python');

function stage(t0, msg) {
  console.log(`[h15-results +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

/** The fixture's p on the drawn surface (as results-tools reads it), times 1000, at `time`. */
function pressureTruth(caseDir, time) {
  const code = [
    'import json, sys',
    'sys.path.insert(0, "tools")',
    'import numpy as np',
    'from pathlib import Path',
    'from case_volume import load_volume',
    'mesh, _ = load_volume(Path(sys.argv[1]), sys.argv[2])',
    'surf = mesh.extract_surface()',
    'if "p" in surf.cell_data and "p" not in surf.point_data:',
    '    surf = surf.cell_data_to_point_data(pass_cell_data=True)',
    'p = np.asarray(surf.point_data["p"], dtype=float) * 1000.0',
    'print(json.dumps({"min": float(p.min()), "max": float(p.max())}))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-c', code, caseDir, String(time)], { cwd: PY_DIR, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`pressure truth failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

test('gate:h15-attach-scope and plugin case results in 3D', async ({ page, request }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const host = await startHost({ name: 'h15-results', pluginsFrom: 'python/tests/fixtures/foam-plugins', env: { MAGNUSIM_WSL_PRUNE: '0' } });
  const { base, projects } = host;
  const newStudy = async (pid, title) => {
    const r = await request.post(`${base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: KEY, kind: 'cavity_case', title } });
    const j = await r.json();
    expect(r.ok(), JSON.stringify(j)).toBe(true);
    return j.study;
  };
  const studyDir = (pid, sid) => join(projects, pid, 'plugins', KEY, 'studies', sid);
  const seed = (pid, sid, rel) => {
    const dir = join(studyDir(pid, sid), ...rel.split('/'));
    mkdirSync(dir, { recursive: true });
    cpSync(FIXTURE, dir, { recursive: true });
    return dir;
  };
  try {
    const one = await newStudy(PROJECT, 'Cavity case 1');
    const two = await newStudy(PROJECT, 'Cavity case 2');
    const other = await newStudy(NO_GEOMETRY_PROJECT, 'Cavity case 1');
    const fixtureDir = seed(PROJECT, one.id, 'cases/fixture');
    const aoaDir = seed(PROJECT, one.id, 'simulations/aoa-5');
    const twoDir = seed(PROJECT, two.id, 'cases/fixture');
    const otherDir = seed(NO_GEOMETRY_PROJECT, other.id, 'cases/fixture');
    // A case that has not run: no saved frame.
    const empty = join(studyDir(PROJECT, one.id), 'cases', 'empty', 'system');
    mkdirSync(empty, { recursive: true });
    cpSync(join(FIXTURE, 'system', 'controlDict'), join(empty, 'controlDict'));
    writeFileSync(join(studyDir(PROJECT, one.id), 'cases', 'empty', 'README.txt'), 'not run yet\n');
    stage(t0, `server up; studies ${one.id}, ${two.id} and ${other.id} seeded`);

    // gate:h15-attach-scope: a plugin case attaches only inside its own plugin study.
    const attach = async (data) => {
      const r = await request.post(`${base}/api/case/attach`, { data });
      return { status: r.status(), body: await r.json().catch(() => ({})) };
    };
    const mine = { project_id: PROJECT, case_dir: fixtureDir, plugin: KEY, plugin_study_id: one.id };
    expect((await attach(mine)).status).toBe(200);
    expect((await attach({ ...mine, case_dir: twoDir })).status).toBe(403);
    expect((await attach({ ...mine, plugin_study_id: two.id })).status).toBe(403);
    expect((await attach({ project_id: PROJECT, case_dir: otherDir, plugin: KEY, plugin_study_id: other.id })).status).toBe(403);
    const pathOnly = await attach({ project_id: PROJECT, path: fixtureDir });
    expect([pathOnly.status, pathOnly.body.error]).toEqual([400, 'use case_dir']);
    const half = await attach({ project_id: PROJECT, case_dir: fixtureDir, plugin: KEY });
    expect([half.status, half.body.error]).toEqual([400, 'plugin and plugin_study_id go together']);
    expect((await attach({ project_id: PROJECT, case_dir: fixtureDir })).status).toBe(403);
    // A plugin case under a folder named "simulations" is the plugin study's, not a core study's.
    expect((await attach({ ...mine, case_dir: aoaDir })).status).toBe(200);
    stage(t0, 'attach scope');

    // The workbench as the user left it: the round plate with its study.
    const runRequests = [];
    page.on('request', (r) => {
      if (/\/api\/runs?(\/|\?|$)/.test(new URL(r.url()).pathname + '?')) runRequests.push(r.url());
    });
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    const scope = () =>
      page.evaluate(() => ({
        study: window.__CFD_W17__?.activeId || null,
        geometry: window.__CFD_W16__?.geometry?.id || null,
        results: window.__CFD_RESULTS_VIEW__ === true,
        caseDir: window.__CFD_W6__?.case_dir || null,
      }));
    await expect.poll(async () => (await scope()).study, { timeout: 60_000 }).toBe(GEOMETRY_REMOVE_IDS.roundStudy);
    expect((await scope()).geometry).toBe(GEOMETRY_REMOVE_IDS.round);

    const overlay = page.locator('#workspace-overlay');
    const frame = page.frameLocator('#workspace-frame');
    const openWorkspace = async (sid) => {
      await page.locator(`#plugin-studies-section [data-plugin-study="${sid}"] > .tree-row`).click();
      await expect(overlay).toBeVisible();
      await expect(frame.locator('body[data-ready="1"]')).toHaveCount(1, { timeout: 60_000 });
    };
    const openIn3D = async (caseRel) => {
      await frame.locator('#case').fill(caseRel);
      await frame.locator('#open3d').click();
    };
    // No core study, for 5 s (polled), and the shown geometry unchanged.
    const noStudyFor5s = async (label) => {
      for (let i = 0; i < 20; i++) {
        const s = await scope();
        expect(s.study, `${label}: active study, check ${i}`).toBeNull();
        expect(s.geometry, `${label}: shown geometry, check ${i}`).toBe(GEOMETRY_REMOVE_IDS.round);
        await page.waitForTimeout(250);
      }
    };

    // First open: no results on screen, so no question.
    await openWorkspace(one.id);
    await openIn3D('cases/fixture');
    await expect(overlay).toBeHidden({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}$`));
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    await expect.poll(async () => (await scope()).caseDir, { timeout: 60_000 }).toContain('fixture');
    await noStudyFor5s('after the open');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cfd:tree-sync')));
    await noStudyFor5s('after a tree sync');
    // The 5 saved frames, after the initial fields at 0 (as for a core run).
    await expect
      .poll(() => page.evaluate(() => (window.__CFD_W12__?.available_times || []).map(String)), { timeout: 60_000 })
      .toEqual(['0', '0.1', '0.2', '0.3', '0.4', '0.5']);
    expect(await page.evaluate(() => window.__CFD_RESULTS_SCALE__)).toBe(1);
    // Views and Compare are hidden while plugin results show.
    await expect(page.locator('#btn-compare')).toBeHidden();
    await expect(page.locator('#views-block')).toBeHidden();
    stage(t0, 'first open: results shown, no study, 5 frames, scale 1');

    // p in Pa: the fixture's kinematic p times rho 1000 (the field is picked in the Cutting planes block).
    await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
    await expect(page.locator('#cp-coloring')).toBeVisible({ timeout: 30_000 });
    await page.locator('#cp-coloring').selectOption('p');
    await expect.poll(() => page.evaluate(() => window.__CFD_W6__?.field), { timeout: 60_000 }).toBe('p');
    await expect.poll(() => page.evaluate(() => window.__CFD_W6__?.fingerprint?.umax ?? null), { timeout: 60_000 }).not.toBeNull();
    await expect(page.locator('#legend')).toContainText('Pa');
    const shown = await page.evaluate(() => ({ time: String(window.__CFD_W6__.time), hi: window.__CFD_W6__.fingerprint.umax, lo: window.__CFD_W6__.fingerprint.umin }));
    const truth = pressureTruth(fixtureDir, shown.time);
    stage(t0, `p shown ${shown.lo}..${shown.hi} Pa at t=${shown.time}; fixture x 1000: ${truth.min}..${truth.max}`);
    const span = Math.max(Math.abs(truth.max), Math.abs(truth.min), 1e-9);
    expect(Math.abs(shown.hi - truth.max) / span).toBeLessThan(0.01);
    expect(runRequests.filter((u) => /pf-[0-9a-f]{12}/.test(u))).toEqual([]);
    stage(t0, 'p legend in Pa matches the fixture x 1000; no run request names the results key');

    // A second open asks first: Cancel keeps the workspace, Open replaces the results.
    await openWorkspace(one.id);
    await openIn3D('simulations/aoa-5');
    await expect(page.locator('#modal-confirm')).toBeVisible();
    await expect(page.locator('#cf-heading')).toHaveText('Open these results?');
    await expect(page.locator('#cf-copy')).toHaveText('This replaces the results currently shown.');
    await expect(page.locator('#cf-confirm')).toHaveText('Open results');
    await page.locator('#cf-cancel').click();
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await expect(overlay).toBeVisible();
    await expect.poll(() => frame.locator('body').evaluate(() => JSON.stringify(window.__cavity.opened))).toBe('{"opened":false}');
    await openIn3D('simulations/aoa-5');
    await expect(page.locator('#modal-confirm')).toBeVisible();
    await page.locator('#cf-confirm').click();
    await expect(overlay).toBeHidden({ timeout: 30_000 });
    await expect.poll(async () => (await scope()).caseDir, { timeout: 120_000 }).toContain('aoa-5');
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    await noStudyFor5s('after the replacing open');
    stage(t0, 'second open asked; Cancel stayed; Open replaced (simulations/aoa-5)');

    // Picking a geometry closes them: the teardrop (no study), then the round plate (its study).
    await page.locator(`#geometries-list .geo-item[data-geom-id="${GEOMETRY_REMOVE_IDS.tear}"]`).click();
    await expect.poll(async () => (await scope()).geometry, { timeout: 30_000 }).toBe(GEOMETRY_REMOVE_IDS.tear);
    await expect.poll(async () => (await scope()).results, { timeout: 30_000 }).toBe(false);
    expect((await scope()).study).toBeNull();
    await page.locator(`#geometries-list .geo-item[data-geom-id="${GEOMETRY_REMOVE_IDS.round}"]`).click();
    await expect.poll(async () => (await scope()).study, { timeout: 30_000 }).toBe(GEOMETRY_REMOVE_IDS.roundStudy);
    expect((await scope()).results).toBe(false);
    stage(t0, 'a geometry pick closed the results; the round plate has its study again');

    // A study click while an open is still loading: the study wins.
    let release = () => {};
    const held = new Promise((r) => (release = r));
    let attachHeld = 0;
    const hold = async (route) => {
      attachHeld += 1;
      await held;
      await route.continue().catch(() => {});
    };
    await page.route('**/api/case/attach', hold);
    await openWorkspace(one.id);
    await openIn3D('cases/fixture');
    await expect(overlay).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => attachHeld, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.locator(`#left-tree [data-w17-sim-id="${GEOMETRY_REMOVE_IDS.roundStudy}"] > .tree-row`).first().click();
    await expect.poll(async () => (await scope()).study, { timeout: 30_000 }).toBe(GEOMETRY_REMOVE_IDS.roundStudy);
    release();
    await page.unroute('**/api/case/attach', hold);
    for (let i = 0; i < 12; i++) {
      const s = await scope();
      expect(s.study, `after the held open, check ${i}`).toBe(GEOMETRY_REMOVE_IDS.roundStudy);
      expect(s.results && /plugins/.test(String(s.caseDir || '')), `plugin results after the held open, check ${i}`).toBe(false);
      await page.waitForTimeout(250);
    }
    expect(await page.evaluate(() => window.__CFD_RESULTS_SCALE__ === 1 && window.__CFD_RESULTS_VIEW__ === true)).toBe(false);
    stage(t0, 'a study click while the open loaded won');

    // A case that has not run: no_results, and the workspace stays.
    await openWorkspace(one.id);
    await openIn3D('cases/empty');
    await expect(frame.locator('#error')).toContainText('no_results');
    await expect(overlay).toBeVisible();
    await expect(frame.locator('#error')).toContainText('no_results');
    stage(t0, 'an empty case answers no_results');

    // Open again, then reload: no results, and the round plate keeps its study.
    await openIn3D('cases/fixture');
    await expect(overlay).toBeHidden({ timeout: 30_000 });
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    await expect.poll(async () => (await scope()).study, { timeout: 60_000 }).toBe(GEOMETRY_REMOVE_IDS.roundStudy);
    for (let i = 0; i < 8; i++) {
      const s = await scope();
      expect(s.results, `after the reload, check ${i}`).toBe(false);
      expect(s.geometry).toBe(GEOMETRY_REMOVE_IDS.round);
      await page.waitForTimeout(250);
    }
    expect(runRequests.filter((u) => /pf-[0-9a-f]{12}/.test(u))).toEqual([]);
    stage(t0, 'after a reload: no results, the study on its geometry');
  } finally {
    host.stop();
  }
});
