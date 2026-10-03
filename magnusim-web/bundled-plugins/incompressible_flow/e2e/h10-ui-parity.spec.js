import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_WSL } from '../../../e2e/support/plugin-suite.js';
import { H10_PROJECT } from './seed.js';

// gate:h10-ui-parity — the Steady-state and Transient UI looks and behaves the
// same after it moved into the Incompressible Flow plugin (H10). Each panel's
// DOM (tags, classes, attributes, text; numbers masked) is compared with the
// baseline recorded from v0.2.0-era code (bundled-plugins/incompressible_flow/e2e/fixtures/h10-ui-parity.json).
// MAGNUSIM_UPDATE_PARITY=1 rewrites the baseline; MAGNUSIM_PARITY_SHOTS=<dir>
// also saves a screenshot of each panel for a pixel comparison.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const PROJECT = H10_PROJECT;
const SIM = 'sim_1';
const BASELINE = resolve('bundled-plugins/incompressible_flow/e2e/fixtures/h10-ui-parity.json');
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

/**
 * The element as indented lines: tag, sorted attributes, own text; numbers
 * masked. Parts matching `skip` (live ones: a plot still growing) are left out.
 */
async function domOf(locator, skip = '') {
  return locator.evaluate((root, skipSel) => {
    // Numbers vary run to run (step counts, times): mask them, and a list of them to one.
    const mask = (s) =>
      String(s)
        // Generated ids (mesh-…, sim-…, run-…, st-…) differ run to run.
        .replace(/\b(?:mesh|sim|run|st|geom|mat|bc|rc)-[a-z0-9-]{4,}/gi, '<id>')
        .replace(/\b(run|mesh):[^/\s"]+/g, '$1:<id>')
        // Bare hex run ids (not colors: those follow '#').
        .replace(/(?<!#)\b[0-9a-f]{6,}\b/gi, '<id>')
        .replace(/-?\d+(?:[.,]\d+)*(?:e[-+]?\d+)?/gi, '#')
        .replace(/#(?:[\s,]+#)+/g, '#')
        .replace(/\s+/g, ' ')
        .trim();
    const out = [];
    const walk = (el, depth) => {
      if (skipSel && el !== root && el.matches(skipSel)) return;
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
  }, skip);
}

// While a run solves, its time left comes and goes with its speed and its
// frame count changes: they are compared by form, not by value.
function liveMask(line) {
  return line.replace(/ · (?:~#(?::#)+|< #s) left/g, '').replace(/# frames?\b/g, '# frames');
}

const captured = {};
async function capture(page, name, locator, opts = {}) {
  await expect(locator).toBeVisible();
  // Let React settle (a preview or registry reply can re-render once more).
  await page.waitForTimeout(400);
  const read = async () => {
    const lines = await domOf(locator, opts.skip || '');
    return opts.live ? lines.map(liveMask) : lines;
  };
  let lines = await read();
  // A panel still loading or solving: take it once two reads a second apart agree.
  if (opts.settle) {
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const again = await read();
      if (again.join('\n') === lines.join('\n')) break;
      lines = again;
    }
  }
  captured[name] = lines;
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
  // The form can still be loading the new mesh's stored settings (fineness 5), which
  // then replace the 1 typed above: set it until it stays 1. A fine mesh (over 50,000
  // cells) solves a transient run on every rank, where the baseline's coarse one was serial.
  const fineness = form.locator('[data-schema-key="fineness"] input');
  await expect
    .poll(
      async () => {
        if ((await fineness.inputValue()) !== '1') await fineness.fill('1');
        await page.waitForTimeout(500);
        return fineness.inputValue();
      },
      { timeout: 30_000 },
    )
    .toBe('1');
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
  const made = (await meshesNow()).find((row) => String(row.id) === meshId) || {};
  stage(t0, `mesh done: ${(made.live_mesh_result || {}).n_cells} cells at fineness ${(made.settings || {}).fineness}`);
  expect((made.settings || {}).fineness, 'the coarse mesh the baseline was recorded on').toBe(1);

  const studyPanel = page.locator('#panel-study-settings .cfd-island');
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
    // The Start gate is the analysis's answer (null until it comes).
    await page.waitForFunction(() => {
      const s = window.__CFD_RUN_STATE__;
      return !!s && s.setup_ready !== null;
    });
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

  // The core's setup tree after all of it (H11: plugin studies sit in their own
  // section below, and the simulations tree itself is unchanged).
  await capture(page, 'tree-simulations', page.locator('#simulations-section'));

  // The results timeline (Animation) runs on each run's x axis: the transient
  // run's in seconds, the steady run's in iterations.
  const animBlock = page.locator('#anim-block');
  const openTimeline = async (rid) => {
    await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
    await page.locator(`#left-tree [data-w27-run-results="${rid}"] > .tree-row .tl`).first().click();
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 180_000 });
    if (!(await animBlock.isVisible())) await page.locator('.tb-btn[data-label="Animation"]').click();
    await expect(animBlock).toBeVisible();
  };
  await openTimeline(transient);
  await expect(page.locator('#anim-window-label')).toHaveText('Start / End', { timeout: 60_000 });
  await expect(page.locator('#anim-time-val')).toHaveText(/ s$/, { timeout: 60_000 });
  await capture(page, 'results-timeline-transient', animBlock, { settle: true });
  await openTimeline(steady);
  await expect(page.locator('#anim-window-label')).toHaveText('Start / End iteration', { timeout: 60_000 });
  await capture(page, 'results-timeline-steady', animBlock, { settle: true });
  stage(t0, 'results timelines');

  // A run while it solves, on its x axis: its Run panel (the residual plot is
  // still growing, and the time left comes and goes: not compared) and its
  // project's card on Home. Each is stopped and deleted afterwards.
  const homeJob = page.locator(`#home-grid .home-card[data-project-id="${PROJECT}"] .home-card-job`);
  const whileSolving = async (label, fields, runLine, stopTitle, homeLine, homeParity) => {
    const rid = await createRun(`Parity live ${label}`);
    await openRun(rid);
    for (const [field, value] of fields) await setField(field, value);
    await expect(runControl.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
    await runControl.locator('[data-run-start]').click();
    await expect(runControl.locator('[data-run-line="1"]')).toHaveText(runLine, { timeout: 600_000 });
    // Stop says what it writes: a transient run's time step, a steady run's iteration.
    await expect(runControl.locator('[data-run-stop="1"]')).toHaveAttribute('title', stopTitle);
    await capture(page, `run-running-${label}`, runPanel, {
      live: true,
      settle: true,
      skip: '[data-residual-wrap="1"], .sim-eta',
    });
    await page.goto('/#/');
    if (homeParity) {
      await expect(homeJob).toHaveText(homeLine, { timeout: 180_000 });
      await capture(page, `home-card-running-${label}`, homeJob, { live: true, settle: true });
    } else if (!UPDATE) {
      // Not compared with the baseline: the code it is recorded on showed no
      // progress on the card while a steady run solved (its iteration reached
      // the saved run only at the end). The card now reads the live run.
      await expect(homeJob).toHaveText(homeLine, { timeout: 120_000 });
    }
    const stop = await request.post('/api/run/stop', { data: { project_id: PROJECT, run_id: rid } });
    expect(stop.ok(), await stop.text()).toBe(true);
    await waitStatus(rid, /^(stopped|done)$/, 300_000);
    const del = await request.post('/api/run/delete', { data: { project_id: PROJECT, simulation_id: SIM, run_id: rid } });
    expect(del.ok(), await del.text()).toBe(true);
    stage(t0, `live ${label} captured`);
  };
  // Transient (the study is transient now): a long run, stopped once captured.
  // It saves a frame every 100 steps: the baseline's code showed the card's
  // progress only from the first saved frame on.
  await whileSolving(
    'transient',
    [['Simulation time', Number((dt * 100_000).toPrecision(4))], ['Result frames', 1000]],
    /^t = \S+ s \/ \S+ s \(\d+%\)/,
    'Write the current time step and stop. Results up to this point stay available.',
    /^\S+ s \/ \S+ s/,
    true,
  );
  // Steady-state.
  await openProject();
  await openStudy();
  await studyPanel.getByLabel('Time dependency').selectOption('Steady-state');
  await expect.poll(async () => (await getJson(request, simUrl)).simulation?.analysis_type).toBe('incompressible_steady');
  await whileSolving(
    'steady',
    [['Iterations', 100_000], ['Write interval', 50_000]],
    /^Iteration \d+ \/ \d+$/,
    'Write the current iteration and stop. Results up to this point stay available.',
    /^\d+ \/ 100000\b/,
    false,
  );

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
