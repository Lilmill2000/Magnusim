import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { H10_PROJECT } from './prepare-projects.js';
import { NO_WSL } from './toolchain.js';

// gate:h10-ui-parity — the Steady-state and Transient UI looks and behaves the
// same after it moved into the Incompressible Flow plugin (H10). Each panel's
// DOM (tags, classes, attributes, text; numbers masked) is compared with the
// baseline recorded from v0.2.0-era code (e2e/fixtures/h10-ui-parity.json).
// MAGNUSIM_UPDATE_PARITY=1 rewrites the baseline; MAGNUSIM_PARITY_SHOTS=<dir>
// also saves a screenshot of each panel for a pixel comparison.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const PROJECT = H10_PROJECT;
const SIM = 'sim_1';
const BASELINE = resolve('e2e/fixtures/h10-ui-parity.json');
const UPDATE = process.env.MAGNUSIM_UPDATE_PARITY === '1';
const SHOTS = process.env.MAGNUSIM_PARITY_SHOTS || '';

function stage(t0, msg) {
  console.log(`[h10 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

async function getJson(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

/** The element as indented lines: tag, sorted attributes, own text; numbers masked. */
async function domOf(locator) {
  return locator.evaluate((root) => {
    // Numbers vary run to run (step counts, times): mask them, and a list of them to one.
    const mask = (s) =>
      String(s)
        .replace(/-?\d+(?:[.,]\d+)*(?:e[-+]?\d+)?/gi, '#')
        .replace(/#(?:[\s,]+#)+/g, '#')
        .replace(/\s+/g, ' ')
        .trim();
    const out = [];
    const walk = (el, depth) => {
      const attrs = [...el.attributes]
        // An emptied inline style (left by focus handling) is no style.
        .filter((a) => !(a.name === 'style' && !a.value.trim()))
        // Run and study ids are random: only their presence is compared.
        .map((a) => `${a.name}="${/(^|-)id$|^data-w27-run/.test(a.name) ? '<id>' : mask(a.value)}"`)
        .sort()
        .join(' ');
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => mask(n.textContent))
        .filter(Boolean)
        .join(' | ');
      out.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>${own ? ' ' + own : ''}`);
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(root, 0);
    return out;
  });
}

const captured = {};
async function capture(page, name, locator) {
  await expect(locator).toBeVisible();
  // Let React settle (a preview or registry reply can re-render once more).
  await page.waitForTimeout(400);
  captured[name] = await domOf(locator);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await locator.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled', caret: 'hide' });
  }
}

test('gate:h10-ui-parity the Steady-state and Transient panels match v0.2.0', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_800_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const t0 = Date.now();
  const statusUrl = `/api/run/status?project_id=${PROJECT}&simulation_id=${SIM}`;
  const runs = async () => (await getJson(request, statusUrl)).runs || [];
  const runRow = async (rid) => (await runs()).find((r) => String(r.id) === String(rid)) || {};
  const simUrl = `/api/simulation?project_id=${PROJECT}&simulation_id=${SIM}`;

  const openProject = async () => {
    await page.goto(`/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  };
  await openProject();

  // The Create Simulation modal, both time dependencies (cancelled: nothing is created).
  await page.locator('#btn-create-simulation').click();
  const modal = page.locator('#modal-create-simulation .cfd-modal-card');
  await expect(page.locator('#cs-type-list [data-analysis-key]').first()).toBeVisible();
  await capture(page, 'create-modal-steady', modal);
  await page.locator('#cs-time-dep [data-time-dep="Transient"]').click();
  await capture(page, 'create-modal-transient', modal);
  await page.locator('#cs-cancel').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden();

  // A coarse mesh (fineness 1, no hex core or layers), as in the h7 gate.
  const meshesNow = async () => (await getJson(request, `/api/mesh?project_id=${PROJECT}&simulation_id=${SIM}`)).meshes || [];
  const beforeIds = new Set((await meshesNow()).map((m) => String(m.id)));
  const meshFolder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] [data-w20-mesh="1"] > .tree-row`).first();
  await meshFolder.locator('.tl').click();
  await page.locator('#btn-create-mesh').click();
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  let meshId = '';
  await expect
    .poll(async () => {
      meshId = (await meshesNow()).map((m) => String(m.id)).find((id) => !beforeIds.has(id)) || '';
      return meshId;
    })
    .not.toBe('');
  await form.locator('[data-schema-key="fineness"] input').fill('1');
  for (const label of ['Hex element core', 'Automatic boundary layers']) {
    const toggle = form.locator(`button[aria-label="${label}"]`);
    if ((await toggle.count()) && (await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  }
  await form.locator('[data-mesh-generate="1"]').click();
  await expect
    .poll(
      async () => {
        const m = (await meshesNow()).find((row) => String(row.id) === meshId) || {};
        const st = (m.live_mesh_result && m.live_mesh_result.status) || 'wait';
        return /done|failed|stopped/.test(st) ? st : 'wait';
      },
      { timeout: 900_000, intervals: [3_000] },
    )
    .toBe('done');
  stage(t0, 'mesh done');

  const studyPanel = page.locator('#panel-incompressible-defaults .cfd-island');
  const openStudy = async () => {
    await page.locator(`#left-tree [data-w17-sim-id="${SIM}"] > .tree-row`).first().click();
    await expect(studyPanel.locator('[data-study-panel="1"]')).toBeVisible({ timeout: 15_000 });
  };
  const runPanel = page.locator('#panel-sim-control .cfd-island');
  const runControl = runPanel.locator('[data-run-control="1"]');
  const openRun = async (rid) => {
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
    if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
      await folder.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
    await expect(runControl).toHaveAttribute('data-run-id', rid);
  };
  const createRun = async (name) => {
    const r = await request.post('/api/run/create', { data: { project_id: PROJECT, simulation_id: SIM, name } });
    const j = await r.json();
    expect(r.ok(), JSON.stringify(j)).toBe(true);
    return j.run_id || (j.run && (j.run.id || j.run.run_id)) || j.id;
  };
  const setField = async (label, value) => {
    const f = runControl.getByLabel(label, { exact: true });
    await f.fill(String(value));
    await f.press('Enter');
  };
  const waitStatus = async (rid, want, timeout) => {
    await expect
      .poll(
        async () => {
          const st = (await runRow(rid)).status || 'none';
          return want.test(st) || /done|failed|stopped/.test(st) ? st : 'waiting';
        },
        { timeout, intervals: [3_000] },
      )
      .toMatch(want);
  };

  // Steady-state: the study panel, a draft run, and the finished run with its residuals.
  await openStudy();
  await capture(page, 'study-steady', studyPanel);
  const steady = await createRun('Parity steady');
  await openRun(steady);
  await capture(page, 'run-draft-steady', runPanel);
  await setField('Iterations', 10);
  await setField('Write interval', 5);
  await expect(runControl.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
  await runControl.locator('[data-run-start]').click();
  await waitStatus(steady, /^done$/, 900_000);
  await openRun(steady);
  await expect(runControl.locator('[data-residual-plot="1"]')).toBeVisible({ timeout: 60_000 });
  await capture(page, 'run-done-steady', runPanel);
  stage(t0, 'steady run done');

  // Transient: the study panel, a draft run with its time-step preview, the
  // advanced settings, and the finished run with residuals and the Courant number.
  await openStudy();
  await studyPanel.getByLabel('Time dependency').selectOption('Transient');
  await expect.poll(async () => (await getJson(request, simUrl)).simulation?.analysis_type).toBe('incompressible_transient');
  await capture(page, 'study-transient', studyPanel);
  const transient = await createRun('Parity transient');
  await openRun(transient);
  await expect(runControl.locator('[data-run-transient-hint]')).toContainText('(auto)', { timeout: 60_000 });
  await capture(page, 'run-draft-transient', runPanel);
  await runControl.locator('details.mesh-advanced > summary').click();
  await capture(page, 'run-draft-transient-advanced', runPanel);
  const pv = await (
    await request.post('/api/run/transient-preview', { data: { project_id: PROJECT, run_id: transient, simulation_id: SIM } })
  ).json();
  const dt = Number(pv.control.delta_t);
  await setField('Simulation time', Number((dt * 40).toPrecision(4)));
  await setField('Result frames', 2);
  await expect(runControl.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
  await runControl.locator('[data-run-start]').click();
  await waitStatus(transient, /^done$/, 900_000);
  await openRun(transient);
  const plot = runControl.locator('[data-residual-plot="1"]');
  await expect(plot).toBeVisible({ timeout: 60_000 });
  await capture(page, 'run-done-transient', runPanel);
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await capture(page, 'residual-tip-transient', runControl.locator('[data-residual-wrap="1"]'));
  stage(t0, 'transient run done');

  // The transient run's Results panel hint (frames, simulation time).
  const results = page.locator(`[data-w27-run-results="${transient}"]`);
  await results.locator(':scope > .tree-row .tl').click();
  await capture(page, 'results-hint-transient', page.locator('#run-results-hint'));

  if (UPDATE || !existsSync(BASELINE)) {
    writeFileSync(BASELINE, JSON.stringify(captured, null, 1) + '\n', 'utf8');
    stage(t0, `baseline written: ${Object.keys(captured).length} panels`);
    return;
  }
  const want = JSON.parse(readFileSync(BASELINE, 'utf8'));
  expect(Object.keys(captured).sort()).toEqual(Object.keys(want).sort());
  for (const name of Object.keys(want)) {
    expect(captured[name].join('\n'), `${name} differs from the v0.2.0 baseline`).toBe(want[name].join('\n'));
  }
});
