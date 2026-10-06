// The Airfoil plugin as the user meets it (H17).
//
// 1. The workspace on an environment without its engines: a copy of the plugin whose
//    lock installs nothing, so this test needs no download. Turned on, Install
//    dependencies, a project with no geometry → header "Airfoil" → "New Airfoil
//    analysis": the NACA 2412 outline and its measures, NeuralFoil's honest message
//    (not installed), XFOIL ready to run (it ships with the plugin) once picked; a new
//    designation is saved and reopens after a reload with the picked engine; a refused one
//    keeps the saved section (its .dat still exports) and Run's reason links to the field;
//    the NACA field looks and behaves as the kit's inputs (Escape puts it back); turned off,
//    the study keeps its bytes and the launcher goes; turned on again, the study reopens
//    (gate:h17-disable-and-remove, its "turned off" half).
// 2. The workspace's inputs, plots and exports, on the same engine-less environment with
//    the shipped XFOIL: points per side and a closed trailing edge (seen in the exported
//    .dat), forced transition, the empty export with its "Run XFOIL" fix, an XFOIL run
//    with per-angle progress, the Cl–α, Cl–Cd, Cm–α and Cp(x) plots (kit LinePlot) with a
//    legend naming the engine and its settings, the Cp angle, the overlay switch, the
//    CSV export, a .dat import through the file picker (and a refused one), and a reload
//    that restores all of it. XFOIL is MIT's Windows build, so this test is Windows only.
// 3. gate:h17-e2e: the real plugin, its real environment (requirements.lock) and the
//    shipped xfoil.exe: the NeuralFoil polar of NACA 2412 at Re 1e6, α −4…10°, the
//    service warmed up as the page opens; with it warm, a changed input redraws it (table
//    and plot) within 1 s; the legend names the Mach number once it is set; XFOIL's Cl
//    at 4° within 2 % of the committed golden, both engines overlaid on the plots and in
//    the CSV, then a case where XFOIL fails at one angle (NACA 0012, Re 1e5, α 10…20°:
//    18°) listed as "did not converge"; after a reload both polars reopen as they were
//    saved (NeuralFoil's is not computed again). Building that environment downloads
//    about 200 MB from PyPI, so the test runs when the environment is already built for
//    this lock (.cache/plugin-envs/, or MAGNUSIM_PLUGIN_ENVS_DIR) or MAGNUSIM_E2E_NETWORK=1
//    allows the download. Otherwise it is skipped and says why, except in the full tier
//    (MAGNUSIM_E2E_WSL=1 or MAGNUSIM_E2E_FULL=1), where it fails: a lock change is exactly
//    when it must run.
// 4. OpenFOAM 2D runs as the study keeps them (seeded results/openfoam.json, no WSL):
//    the panel's defaults, its honest reasons (no Gmsh in this environment; a Reynolds
//    number below 1e5, with a fix that goes to the field; Mach not used), angle and mesh
//    kept, the runs listed newest first with their status, the polar of the inputs and
//    mesh in the table and the plots, the CSV with every run, a run deleted after the
//    app's question, all reopened. Tests 1, 2 and 4 are the per-commit checks.
// 5. gate:h17-openfoam-2d (the local tier, MAGNUSIM_E2E_WSL=1, under the machine's WSL
//    lock; also needs the plugin's environment, and Windows for XFOIL): XFOIL with
//    transition forced at 5 % of the chord, then OpenFOAM 2D at 4°, 0° and 8°: the three
//    cases are written and queued behind one another on the compute slot, the 8° one is
//    stopped from the queue, residuals show while 4° solves, a reload then follows the
//    running and the queued case again, both end steady, each
//    ran in a cfddesk-pf-airfoil-… WSL folder, Cl at 4° is within 10 % of XFOIL's, the
//    OpenFOAM line joins the plots, a reload reopens it, and Open in 3D shows the case's
//    frames in the project's viewer.
// 6. gate:h17-disable-and-remove, its "folder removed" half (per commit, no download): a
//    project with an Airfoil study, then the app started on bundled plugins without the
//    Airfoil folder: the project opens, Incompressible Flow is on, the study row is greyed
//    with its fix, a link to the study says which plugin it needs by name, no launcher,
//    no page error, and not a byte of the project changes; the folder back, the study
//    reopens as it was.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  acquireWslLock,
  computeQueue,
  e2eTemp,
  foamRecords,
  killFoamRelays,
  NO_GEOMETRY_PROJECT,
  NO_WSL,
  prepareE2eProjectsRoot,
  removeTestWslRoot,
  startHost,
} from '../../../e2e/support/plugin-suite.js';

const KEY = 'airfoil';
// gate:h17-openfoam-2d runs real OpenFOAM in WSL: the local tier only (MAGNUSIM_E2E_WSL=1).
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const START = 'airfoil:airfoil_analysis';
const PROJECT = NO_GEOMETRY_PROJECT;
const GOLDEN = 'bundled-plugins/airfoil/tests/goldens/xfoil_naca2412_re1e6.json';
// gate:h17-e2e: with the service warm, the NeuralFoil polar redraws within 1 s of an input change.
const WARM_REDRAW_MS = 1_000;
// The full tier (before a push, nightly): the engine gates run there, so an environment that
// is not built for this lock fails them instead of skipping them.
const FULL = WSL || process.env.MAGNUSIM_E2E_FULL === '1';
const ENV_NOT_BUILT =
  "the Airfoil plugin's environment is not built for this requirements.lock, and building it downloads about 200 MB from PyPI: build it once in Settings → Plugins → Install dependencies, or set MAGNUSIM_E2E_NETWORK=1 to allow the download (nightly)";

/**
 * The plugin's environment is built for this requirements.lock (the host's own rule,
 * python/cfddesk/registry/plugin_env.py: <envs>/airfoil-<first 16 hex of the lock's
 * SHA-256, CRLF read as LF>/magnusim-env.json naming that hash).
 */
function envReady() {
  try {
    const lock = readFileSync(resolve('bundled-plugins/airfoil/requirements.lock')).toString('latin1').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(Buffer.from(lock, 'latin1')).digest('hex').slice(0, 16);
    const root = process.env.MAGNUSIM_PLUGIN_ENVS_DIR?.trim() || resolve('.cache', 'plugin-envs');
    const dir = join(root, `${KEY}-${hash}`);
    const stamp = JSON.parse(readFileSync(join(dir, 'magnusim-env.json'), 'utf8'));
    const py = process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python');
    return stamp.lock_hash === hash && existsSync(py);
  } catch {
    return false;
  }
}

/** The engine gates' environment: built, or allowed to download; else skip (fail in the full tier). */
function needEnv() {
  if (envReady() || process.env.MAGNUSIM_E2E_NETWORK === '1') return;
  if (FULL) throw new Error(`${ENV_NOT_BUILT}. The full tier runs this gate; it does not skip it.`);
  test.skip(true, ENV_NOT_BUILT);
}

function stage(t0, msg) {
  console.log(`[airfoil +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

const frame = (page) => page.frameLocator('#workspace-frame');
const overlay = (page) => page.locator('#workspace-overlay');

async function openProject(page, base, pid) {
  await page.goto(`${base}/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

/** Settings → Plugins → the plugin's Disable or Enable button. */
async function togglePlugin(page, want) {
  await page.locator('#wb-prefs').click();
  const wizard = page.locator('#setup-wizard');
  await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
  const row = wizard.locator(`.wiz-pane[data-wiz-step="5"] [data-plugin-key="${KEY}"]`);
  await row.locator(`[data-plugin-toggle="${KEY}"]`).click();
  await expect(row).toHaveAttribute('data-plugin-status', want, { timeout: 30_000 });
  await page.locator('#wiz-next').click();
  await expect(wizard).toBeHidden();
}

/** Settings → Plugins → Install dependencies, then wait until the row says On. */
async function installDependencies(page, timeout) {
  await page.locator('#wb-prefs').click();
  const wizard = page.locator('#setup-wizard');
  await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
  const row = wizard.locator(`.wiz-pane[data-wiz-step="5"] [data-plugin-key="${KEY}"]`);
  await expect(row).toHaveAttribute('data-plugin-status', /needs setup|enabled/, { timeout: 30_000 });
  if ((await row.getAttribute('data-plugin-status')) === 'needs setup') {
    await expect(row.locator('.wiz-plugin-status')).toHaveText('Needs setup');
    await row.locator(`[data-plugin-install="${KEY}"]`).click();
  }
  await expect(row).toHaveAttribute('data-plugin-status', 'enabled', { timeout });
  await expect(row.locator('.wiz-plugin-status')).toHaveText('On');
  await page.locator('#wiz-next').click();
  await expect(wizard).toBeHidden();
}

/** The header's Airfoil button → "New Airfoil analysis"; resolves the new study's id. */
async function newStudyFromHeader(page, pid) {
  const button = page.locator(`#ws-start-host [data-start-header="${START}"] > button`);
  await expect(button).toHaveText('Airfoil');
  await button.click();
  const item = page.locator(`[data-start-new="${START}"]`);
  await expect(item).toHaveText('New Airfoil analysis');
  await item.click();
  await expect(overlay(page)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/ws/${KEY}/polar/(st-[0-9a-f]+)$`));
  return page.url().match(/\/(st-[0-9a-f]+)$/)[1];
}

/**
 * A host on a copy of the bundled plugins whose Airfoil lock installs nothing: no download.
 * `projects` and `envs` (folders the caller keeps) let a second host open the same projects;
 * `airfoil: false` leaves the Airfoil folder out of the copy (the plugin removed).
 */
async function startEngineLessHost(name, { projects, envs, airfoil = true } = {}) {
  const tmp = e2eTemp(name);
  if (!projects) {
    projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
  }
  const bundled = join(tmp, 'bundled');
  const skip = (src) => !/[\\/](tests|e2e|__pycache__|node_modules)([\\/]|$)/.test(src);
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), { recursive: true, filter: skip });
  if (airfoil) {
    cpSync(resolve('bundled-plugins/airfoil'), join(bundled, KEY), { recursive: true, filter: skip });
    // An environment with nothing in it: the service runs, NeuralFoil is not there.
    writeFileSync(join(bundled, KEY, 'requirements.lock'), '# e2e: the workspace without its engines (no packages)\n');
  }
  const host = await startHost({
    name,
    tmp,
    projects,
    bundledDir: bundled,
    enablePlugins: airfoil ? [KEY] : [],
    env: { MAGNUSIM_PLUGIN_ENVS_DIR: envs || join(tmp, 'envs') },
  });
  return { host, tmp, projects };
}

/** Every Airfoil service call the page makes from now on, by method name, in order. */
function recordServiceCalls(page) {
  const calls = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/api\/plugin\/airfoil\/([a-z_]+)\?/);
    if (m) calls.push(m[1]);
  });
  return calls;
}

/**
 * What a kit LinePlot draws, in the data's own units: each line's points, read back from
 * the SVG through its tick labels (the first and last tick of each axis).
 */
async function plotLines(page, af) {
  return workspaceFrame(page).evaluate((af) => {
    const svg = document.querySelector(`[data-af="${af}"] svg.mgk-plot-svg`);
    if (!svg) return null;
    const bottom = svg.viewBox.baseVal.height - 4;
    const num = (t) => Number(String(t).replace('−', '-').replace('°', ''));
    const texts = [...svg.querySelectorAll('text')]
      .map((t) => ({ v: num(t.textContent), x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')) }))
      .filter((t) => Number.isFinite(t.v));
    const xt = texts.filter((t) => t.y === bottom);
    const yt = texts.filter((t) => t.y !== bottom).map((t) => ({ ...t, y: t.y - 3 }));
    const scale = (ticks, k) => {
      const a = ticks[0];
      const b = ticks[ticks.length - 1];
      return (s) => a.v + ((s - a[k]) * (b.v - a.v)) / (b[k] - a[k]);
    };
    const fx = scale(xt, 'x');
    const fy = scale(yt, 'y');
    return [...svg.querySelectorAll('polyline.mgk-plot-line')].map((pl) =>
      pl
        .getAttribute('points')
        .trim()
        .split(/\s+/)
        .map((pt) => {
          const [x, y] = pt.split(',').map(Number);
          return { x: fx(x), y: fy(y) };
        }),
    );
  }, af);
}

/** Every file under a folder with its bytes' SHA-256, by path. */
function hashTree(dir, out = {}, root = dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) hashTree(p, out, root);
    else out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  return out;
}

/** A table cell as a number ("−0.1934" → -0.1934). */
async function cellNumber(cell) {
  return Number((await cell.textContent()).replace('−', '-'));
}

/** Commit a kit number field in the workspace: type, then Enter. */
async function commitField(ws, id, value) {
  const input = ws.locator(`#${id}`);
  await input.fill(String(value));
  await input.press('Enter');
}

/** Turn a kit switch on or off as the user does: a click on its track. */
async function setSwitch(ws, id, on) {
  const input = ws.locator(`#${id}`);
  if ((await input.isChecked()) !== on) await ws.locator(`label.mgk-switch:has(#${id})`).click();
  await expect(input).toBeChecked({ checked: on });
}

/** The workspace page's own frame (for what a locator cannot do: watching the page change). */
function workspaceFrame(page) {
  const f = page.frames().find((fr) => /\/plugins\/airfoil\/workspace\//.test(fr.url()));
  if (!f) throw new Error('no Airfoil workspace frame');
  return f;
}

/** Record every line the XFOIL progress block shows from now on; returns a reader. */
async function recordProgress(page) {
  const f = workspaceFrame(page);
  await f.evaluate(() => {
    const seen = [];
    window.__afProgress = seen;
    const look = () => {
      const el = document.querySelector('[data-af="xfoil-progress"] .mgk-status-line');
      const text = el && el.textContent;
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () => f.evaluate(() => window.__afProgress);
}

/** Click an export button and read the file the browser downloads. */
async function exportFile(page, ws, which) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), ws.locator(`[data-af="export-${which}"]`).click()]);
  return { name: dl.suggestedFilename(), text: readFileSync(await dl.path(), 'utf8') };
}

/** Hover a plot at a fraction of its width and read the kit's tip. */
async function plotTip(ws, af, fraction) {
  const plot = ws.locator(`[data-af="${af}"] .mgk-plot`);
  const box = await plot.boundingBox();
  await plot.hover({ position: { x: box.width * fraction, y: box.height / 2 } });
  const tip = ws.locator(`[data-af="${af}"] .mgk-plot-tip`);
  await expect(tip).toBeVisible();
  return (await tip.textContent()) || '';
}

// Where α = 4° sits on an α axis from −5° to 10° (α −4…10° gets round ends −5 and 10):
// the kit's plot is 280 units wide with 36 left and 8 right of the drawing.
const ALPHA4_ON_MINUS5_TO_10 = (36 + (9 / 15) * 236) / 280;
const CSV_HEADER =
  'engine,model,airfoil,re,mach,ncrit,trip_top_x_c,trip_bottom_x_c,alpha_deg,status,cl,cd,cm,cl_cd,transition_top_x_c,transition_bottom_x_c,confidence';

test('the Airfoil workspace: section preview, saved inputs, honest engine messages, off and on again (gate:h17-disable-and-remove, turned off)', async ({
  page,
}) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const calls = recordServiceCalls(page);
  const { host, projects } = await startEngineLessHost('airfoil-ui');
  const { base } = host;
  try {
    stage(t0, `server up at ${base}`);
    await openProject(page, base, PROJECT);
    // Needs setup: no launcher yet.
    await expect(page.locator(`#ws-start-host [data-start-header="${START}"]`)).toHaveCount(0);
    await installDependencies(page, 180_000);
    stage(t0, 'environment ready');

    // The empty project offers the start action with its hint.
    await expect(page.locator(`#wb-empty-start [data-start-empty="${START}"]`)).toHaveText('Analyze an airfoil');
    await expect(page.locator('#wb-empty-start')).toContainText('Polars of a 2D section from NeuralFoil, XFOIL and OpenFOAM');
    const sid = await newStudyFromHeader(page, PROJECT);
    stage(t0, `study ${sid} opened`);

    const ws = frame(page);
    await expect(ws.locator('[data-af="outline"]')).toBeVisible({ timeout: 60_000 });
    await expect(ws.locator('.af-inputs')).toContainText('NACA 2412 · thickness 12.00 % at 30');
    await expect(ws.locator('.af-inputs')).toContainText('camber 2.00 % at 40');
    await expect(ws.locator('[data-af="naca"]')).toHaveValue('2412');
    // NeuralFoil is the engine a new study opens on.
    await expect(ws.locator('#af-engine')).toHaveValue('neuralfoil');
    await expect(ws.locator('[data-af="neuralfoil"]')).toContainText("NeuralFoil is not installed in the Airfoil plugin's environment", {
      timeout: 60_000,
    });
    await expect(ws.locator('[data-af="neuralfoil"]')).toContainText('Install dependencies');
    // The page warmed the service up as it opened: NeuralFoil's answer is in, nothing is computing.
    expect(calls, 'the page did not warm the service up').toContain('warmup');
    await expect(ws.locator('[data-af="neuralfoil"]')).toContainText('No NeuralFoil polar yet');
    await expect(ws.locator('[data-af="neuralfoil"]')).not.toContainText('Computing the polar…');
    await expect(ws.locator('[data-af="plots"]')).toContainText('No polar yet');
    // XFOIL ships with the plugin: picked, it is ready to run, nothing run yet.
    await ws.locator('#af-engine').selectOption('xfoil');
    if (process.platform === 'win32') {
      await expect(ws.locator('[data-af="run-xfoil"]')).toBeEnabled();
    } else {
      await expect(ws.locator('[data-af="run-xfoil"]')).toBeDisabled();
      await expect(ws.locator('[data-af="xfoil"]')).toContainText(
        'XFOIL ships as a Windows program (xfoil.exe), so it runs on Windows only.',
      );
    }
    await expect(ws.locator('[data-af="xfoil"]')).toContainText('No XFOIL polar yet');
    // The study record now holds the defaults and the picked engine.
    const studyFile = join(projects, PROJECT, 'plugins', KEY, 'studies', sid, 'study.json');
    await expect.poll(() => JSON.parse(readFileSync(studyFile, 'utf8')).conditions?.re ?? null).toBe(1e6);
    await expect.poll(() => JSON.parse(readFileSync(studyFile, 'utf8')).view?.engine ?? null).toBe('xfoil');
    await page.screenshot({ path: test.info().outputPath('workspace-2412.png') });

    // The dimensions, from 2412's digits, and drawn on the section as on an airfoil diagram.
    const dim = (id) => ws.locator(`#${id}`);
    await expect(dim('af-dim-thickness')).toHaveValue('12');
    await expect(dim('af-dim-thickness-at')).toHaveValue('30');
    await expect(dim('af-dim-camber')).toHaveValue('2');
    await expect(dim('af-dim-camber-at')).toHaveValue('40');
    await expect(dim('af-dim-le')).toHaveValue('1.587');
    for (const mark of ['dim-camber', 'dim-thickness', 'dim-le-circle']) await expect(ws.locator(`[data-af="${mark}"]`)).toHaveCount(1);
    await expect(ws.locator('[data-af="dim-thickness"]')).toContainText('thickness 12.0 % at 30 %');
    await expect(ws.locator('[data-af="dim-camber"]')).toContainText('camber 2.0 % at 40 %');
    const leR = async () => Number(await ws.locator('[data-af="dim-le-circle"] circle').getAttribute('r'));
    const r0 = await leR();
    // A blunter nose: a NACA 4-digit-modified section named by its dimensions, drawn and saved.
    await commitField(ws, 'af-dim-le', 2.5);
    await expect(ws.locator('.af-inputs')).toContainText('Custom t12.0@30 c2.0@40 r2.50 · thickness 12.00 %');
    // No NACA digits for it: the field is empty and shows the section's name.
    await expect(ws.locator('[data-af="naca"]')).toHaveValue('');
    await expect(ws.locator('[data-af="naca"]')).toHaveAttribute('placeholder', 'Custom t12.0@30 c2.0@40 r2.50');
    await expect.poll(leR).toBeGreaterThan(r0 * 1.5);
    await expect
      .poll(() => JSON.parse(readFileSync(studyFile, 'utf8')).airfoil ?? null)
      .toMatchObject({ source: 'shape', thickness: 0.12, thickness_at: 0.3, camber: 0.02, camber_at: 0.4, le_radius: 0.025 });
    // A thicker section keeps the nose's index: its radius grows with the thickness squared.
    await commitField(ws, 'af-dim-thickness', 15);
    await expect(dim('af-dim-le')).toHaveValue('3.906');
    await expect(ws.locator('.af-inputs')).toContainText('thickness 15.00 % at 30');
    // The thickest point moves back.
    await commitField(ws, 'af-dim-thickness-at', 45);
    await expect(ws.locator('.af-inputs')).toContainText(/thickness 1(4\.99|5\.00) % at 4[4-6]/);
    // A dimension the family cannot make: the reason, its field, and nothing saved.
    await commitField(ws, 'af-dim-thickness-at', 70);
    await expect(ws.locator('.af-inputs [role="alert"]')).toHaveText(/Maximum-thickness position must be 20 % to 60 % of the chord/);
    expect(JSON.parse(readFileSync(studyFile, 'utf8')).airfoil.thickness_at, 'a refused dimension was saved').toBe(0.45);
    // Whole designation digits are named as the family names them.
    // Each edit waits for the one before to land (the radius field shows the new radius).
    await commitField(ws, 'af-dim-thickness-at', 30);
    await expect(ws.locator('.af-inputs')).toContainText(/thickness 1(4\.99|5\.00) % at 30/);
    await commitField(ws, 'af-dim-thickness', 12);
    await expect(dim('af-dim-le')).toHaveValue('2.5');
    await commitField(ws, 'af-dim-le', 1.587);
    await expect(ws.locator('.af-inputs')).toContainText('NACA 2412-63 · thickness 12.00 %');
    await page.screenshot({ path: test.info().outputPath('workspace-dimensions.png') });
    // A NACA designation makes it that section again.
    await ws.locator('[data-af="naca"]').fill('2412');
    await ws.locator('[data-af="naca"]').press('Enter');
    await expect(ws.locator('.af-inputs')).toContainText('NACA 2412 · thickness 12.00 %');
    await expect.poll(() => JSON.parse(readFileSync(studyFile, 'utf8')).airfoil?.source ?? null).toBe('naca');
    stage(t0, 'dimensions: edited, drawn, named, refused, and back to NACA 2412');

    // A new designation: the preview follows and the study keeps it.
    await ws.locator('[data-af="naca"]').fill('0012');
    await ws.locator('[data-af="naca"]').press('Enter');
    await expect(ws.locator('.af-inputs')).toContainText('NACA 0012 · thickness 12.00 %');
    await expect(ws.locator('.af-inputs')).toContainText('camber 0.00 %');
    await expect.poll(() => JSON.parse(readFileSync(studyFile, 'utf8')).airfoil?.code ?? null).toBe('0012');
    // A designation that is not one: the reason, and the saved study is unchanged.
    await ws.locator('[data-af="naca"]').fill('24x2');
    await ws.locator('[data-af="naca"]').press('Enter');
    await expect(ws.locator('.af-inputs [role="alert"]')).toHaveText(/Enter a NACA 4-digit or 5-digit designation/);
    // Run XFOIL says why it cannot run, and its link goes to the field (in the Section card).
    if (process.platform === 'win32') {
      await expect(ws.locator('[data-af="run-xfoil"]')).toBeDisabled();
      await expect(ws.locator('[data-af="xfoil"]')).toContainText('Fix the inputs first: Enter a NACA 4-digit or 5-digit designation');
      await ws.locator('[data-af="xfoil"]').getByRole('button', { name: 'Change the NACA designation' }).click();
      await expect(ws.locator('#af-naca')).toBeFocused();
    }
    expect(JSON.parse(readFileSync(studyFile, 'utf8')).airfoil.code, 'a refused input was saved').toBe('0012');
    // The section the outline shows (the last one that passed) still exports.
    await expect(ws.locator('[data-af="export-dat"]')).toBeEnabled();
    expect((await exportFile(page, ws, 'dat')).name).toBe('NACA 0012.dat');
    // Run OpenFOAM says the same, with the same link.
    await ws.locator('#af-engine').selectOption('openfoam');
    const ofPanel = ws.locator('[data-af="openfoam"]');
    await expect(ofPanel).toContainText('Fix the inputs first: Enter a NACA 4-digit or 5-digit designation');
    await ws.locator('[data-af="naca"]').blur();
    await ofPanel.getByRole('button', { name: 'Change the NACA designation' }).click();
    await expect(ws.locator('#af-naca')).toBeFocused();
    await ws.locator('[data-af="naca"]').fill('0012');
    await ws.locator('[data-af="naca"]').press('Enter');
    await expect(ws.locator('.af-inputs [role="alert"]')).toHaveCount(0);
    // A condition the check refuses names its own field: the last α below the first.
    await commitField(ws, 'af-a1', -10);
    await expect(ofPanel).toContainText('Fix the inputs first: The last α must not be below the first.');
    await ofPanel.getByRole('button', { name: 'Change the last α' }).click();
    await expect(ws.locator('#af-a1')).toBeFocused();
    await commitField(ws, 'af-a1', 10);
    await expect(ws.locator('.af-inputs [role="alert"]')).toHaveCount(0);
    await ws.locator('#af-engine').selectOption('xfoil');
    stage(t0, 'inputs saved, refusals link to their fields');

    // The NACA field is drawn and keyed as the kit's inputs: Escape puts the saved designation back.
    const naca = ws.locator('[data-af="naca"]');
    const look = (id) =>
      ws.locator(`#${id}`).evaluate((el) => {
        const c = getComputedStyle(el);
        return [c.fontFamily, c.fontSize, c.fontWeight, c.color, c.backgroundColor, c.borderTopColor, c.borderTopWidth, el.getBoundingClientRect().height];
      });
    expect(await look('af-naca')).toEqual(await look('af-re'));
    await naca.fill('4412');
    await naca.press('Escape');
    await expect(naca).toHaveValue('0012');
    await ws.locator('.af-inputs h2').first().click();
    await expect(naca).not.toBeFocused();
    await page.waitForTimeout(1_000);
    await expect(ws.locator('.af-inputs')).toContainText('NACA 0012 ·');
    expect(JSON.parse(readFileSync(studyFile, 'utf8')).airfoil.code, 'Escape then a click away saved the typed text').toBe('0012');

    await page.reload();
    await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
    await expect(frame(page).locator('[data-af="naca"]')).toHaveValue('0012', { timeout: 60_000 });
    await expect(frame(page).locator('.af-inputs')).toContainText('NACA 0012');
    await expect(frame(page).locator('#af-engine')).toHaveValue('xfoil');
    stage(t0, 'reopened after a reload');

    // Off: the study stays on disk untouched, greyed, and no launcher is left.
    await overlay(page).locator('[data-ws-back]').click();
    await expect(overlay(page)).toBeHidden();
    const bytes = readFileSync(studyFile);
    await togglePlugin(page, 'disabled');
    const row = page.locator(`#plugin-studies-section [data-plugin-study="${sid}"]`);
    await expect(row).toHaveClass(/is-unavailable/, { timeout: 30_000 });
    await expect(page.locator(`#ws-start-host [data-start-header="${START}"]`)).toHaveCount(0);
    await expect(page.locator(`#wb-empty-start [data-start-empty="${START}"]`)).toHaveCount(0);
    expect(readFileSync(studyFile).equals(bytes), 'turning the plugin off changed its study').toBe(true);
    stage(t0, 'off: greyed, no launcher, bytes unchanged');

    // On again: the study opens as it was.
    await togglePlugin(page, 'enabled');
    await page.locator(`#ws-start-host [data-start-header="${START}"] > button`).click();
    await page.locator(`[data-start-study="${sid}"]`).click();
    await expect(overlay(page)).toBeVisible({ timeout: 30_000 });
    await expect(frame(page).locator('[data-af="naca"]')).toHaveValue('0012', { timeout: 60_000 });
    stage(t0, 'on again: reopened');
  } finally {
    host.stop();
  }
});

test('the Airfoil workspace: inputs, an XFOIL run with progress, the four plots, CSV and .dat export, .dat import, all reopened', async ({
  page,
}) => {
  test.skip(process.platform !== 'win32', "xfoil.exe is MIT's Windows build: it runs on Windows only, and the plots here need its polar");
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const { host, tmp, projects } = await startEngineLessHost('airfoil-ws');
  const { base } = host;
  try {
    stage(t0, `server up at ${base}`);
    await openProject(page, base, PROJECT);
    await installDependencies(page, 180_000);
    const sid = await newStudyFromHeader(page, PROJECT);
    const ws = frame(page);
    const studyDir = join(projects, PROJECT, 'plugins', KEY, 'studies', sid);
    const study = () => JSON.parse(readFileSync(join(studyDir, 'study.json'), 'utf8'));
    await expect(ws.locator('[data-af="outline"]')).toBeVisible({ timeout: 60_000 });
    stage(t0, `study ${sid} opened`);

    // Points per side and a closed trailing edge: the preview, the record and the .dat follow.
    await commitField(ws, 'af-pps', 41);
    await expect(ws.locator('.af-inputs')).toContainText('NACA 2412 · thickness 12.00 %');
    await expect(ws.locator('.af-inputs')).toContainText('· 81 points');
    await setSwitch(ws, 'af-closed-te', true);
    await expect.poll(() => study().airfoil).toEqual({ source: 'naca', code: '2412', points_per_side: 41, closed_te: true });
    const dat = await exportFile(page, ws, 'dat');
    expect(dat.name).toBe('NACA 2412.dat');
    const datLines = dat.text.trimEnd().split('\n');
    expect(datLines[0]).toBe('NACA 2412');
    expect(datLines).toHaveLength(1 + 81);
    expect(datLines[1], 'a closed trailing edge starts and ends at one point').toBe(datLines[81]);
    expect(datLines[1].trim().split(/\s+/).map(Number)).toEqual([1, 0]);
    stage(t0, 'points per side, closed trailing edge, .dat exported');

    // Forced transition: the trips appear, at x/c 0.05 until changed, and are saved.
    await expect(ws.locator('#af-xtr-top')).toHaveCount(0);
    await setSwitch(ws, 'af-forced', true);
    await expect(ws.locator('#af-xtr-top')).toHaveValue('0.05');
    await commitField(ws, 'af-xtr-top', 0.1);
    await expect.poll(() => [study().conditions.xtr_top, study().conditions.xtr_bottom]).toEqual([0.1, 0.05]);
    // A Mach number: XFOIL gets it, and the legends name it.
    await commitField(ws, 'af-mach', 0.2);
    await expect.poll(() => study().conditions.mach).toBe(0.2);

    // Nothing to export yet: the reason, and its fix runs XFOIL (with per-angle progress).
    // The CSV button says it exports every engine's polar, whichever table is shown.
    await expect(ws.locator('[data-af="export-csv"]')).toHaveText('Export all polars (CSV)');
    await expect(ws.locator('[data-af="export-csv"]')).toBeDisabled();
    const table = ws.locator('[data-af="table"]');
    await expect(table).toContainText('No polar to export yet.');
    const progress = await recordProgress(page);
    await table.locator('.mgk-reason button', { hasText: 'Run XFOIL' }).click();
    await expect(ws.locator('#af-engine')).toHaveValue('xfoil');
    const xfTable = ws.locator('[data-af="xfoil-table"]');
    await expect(xfTable.locator('tbody tr')).toHaveCount(15, { timeout: 120_000 });
    await expect(ws.locator('[data-af="xfoil"]')).toContainText(
      /NACA 2412 · Re 1\.00e\+6 · Mach 0\.2 · Ncrit 9 · trip 0\.1\/0\.05 · 1[345] of 15 angles converged/,
    );
    const lines = await progress();
    stage(t0, `XFOIL ran; progress lines seen: ${JSON.stringify(lines)}`);
    expect(lines.length, 'no per-angle progress was shown').toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^Starting$|^α = −?\d+(\.\d+)?° · \d+ of 15$/);
    expect(
      lines.some((l) => / of 15$/.test(l)),
      'no angle was counted',
    ).toBe(true);
    await expect.poll(() => study().view?.engine ?? null).toBe('xfoil');

    // The four plots: one XFOIL line each, named with its settings; Cp(x) at 4°.
    const legend = 'XFOIL · NACA 2412 · Re 1.00e+6 · Mach 0.2 · Ncrit 9 · trip 0.1/0.05';
    for (const af of ['plot-cl-alpha', 'plot-cl-cd', 'plot-cm-alpha']) {
      await expect(ws.locator(`[data-af="${af}"] polyline.mgk-plot-line`)).toHaveCount(1);
      await expect(ws.locator(`[data-af="${af}"] .mgk-plot-key`)).toHaveText([legend]);
    }
    // α runs from −5° to 10° on round ticks, below zero too.
    await expect(ws.locator('[data-af="plot-cl-alpha"] svg text', { hasText: '°' })).toHaveText(['−5°', '0°', '5°', '10°']);
    const cl4 = (await xfTable.locator('tr[data-alpha="4"] [data-col="cl"]').textContent()).trim();
    const tip = await plotTip(ws, 'plot-cl-alpha', ALPHA4_ON_MINUS5_TO_10);
    expect(tip).toContain('α = 4°');
    expect(tip).toContain(`XFOIL ${cl4}`);
    // One point per converged angle on the drag polar, in α order: (Cd, Cl) of each.
    const converged = await xfTable.locator('tbody tr:not(.af-missing)').count();
    const dragPoints = (await ws.locator('[data-af="plot-cl-cd"] polyline.mgk-plot-line').getAttribute('points')).split(' ');
    expect(dragPoints).toHaveLength(converged);
    const xfSaved = () => JSON.parse(readFileSync(join(studyDir, 'results', 'xfoil.json'), 'utf8'));
    const [drag] = await plotLines(page, 'plot-cl-cd');
    const byAlpha = [...xfSaved().rows].sort((p, q) => p.alpha - q.alpha);
    expect(drag).toHaveLength(byAlpha.length);
    drag.forEach((pt, i) => {
      expect(Math.abs(pt.x - byAlpha[i].cd), `Cd at ${byAlpha[i].alpha}°`).toBeLessThan(2e-4);
      expect(Math.abs(pt.y - byAlpha[i].cl), `Cl at ${byAlpha[i].alpha}°`).toBeLessThan(0.01);
    });
    // Its x axis is Cd: small round numbers, not angles.
    const cdTicks = await ws.locator('[data-af="plot-cl-cd"] svg text[text-anchor="middle"]').allTextContents();
    expect(cdTicks.length).toBeGreaterThan(0);
    for (const t of cdTicks) expect(Number(t), `Cd tick ${t}`).toBeGreaterThan(0);
    for (const t of cdTicks) expect(Number(t), `Cd tick ${t}`).toBeLessThan(0.1);
    // Cm against α reads Cm, not Cl.
    const cm4 = (await xfTable.locator('tr[data-alpha="4"] [data-col="cm"]').textContent()).trim();
    const cmTip = await plotTip(ws, 'plot-cm-alpha', ALPHA4_ON_MINUS5_TO_10);
    expect(cmTip).toContain(`α = 4°XFOIL ${cm4}`);
    // and its line is drawn on a Cm scale (a few hundredths), not Cl's.
    const cmScale = (await ws.locator('[data-af="plot-cm-alpha"] svg text[text-anchor="end"]').allTextContents()).filter((t) => t !== 'Cm' && !t.endsWith('°'));
    expect(cmScale.length).toBeGreaterThan(1);
    for (const t of cmScale) expect(Math.abs(Number(t)), `Cm tick ${t}`).toBeLessThan(0.3);
    await expect(ws.locator('[data-af="plot-cp"] figcaption')).toHaveText('Cp(x) at α = 4°');
    await expect(ws.locator('[data-af="plot-cp"] polyline.mgk-plot-line')).toHaveCount(2);
    await expect(ws.locator('[data-af="plot-cp"] .mgk-plot-key')).toHaveText(['XFOIL, upper surface', 'XFOIL, lower surface']);
    // x/c from 0 to 1 along the chord.
    await expect(ws.locator('[data-af="plot-cp"] svg text[text-anchor="start"]')).toHaveText(['0.00']);
    await expect(ws.locator('[data-af="plot-cp"] svg text[text-anchor="middle"]')).toHaveText(['0.25', '0.50', '0.75']);
    // What it draws: −Cp upward, the upper surface's suction peak above the lower surface,
    // each line XFOIL's own numbers at the chosen angle.
    const cpOf = (key) => {
      const { x, cp } = xfSaved().cp[key];
      let le = 0;
      for (let i = 1; i < x.length; i++) if (x[i] < x[le]) le = i;
      const up = cp.slice(0, le + 1).map((v) => -v);
      const lo = cp.slice(le + 1).map((v) => -v);
      return { up: Math.max(...up), lo: Math.max(...lo), least: Math.min(...up, ...lo) };
    };
    const drawnCp = async () => {
      const [up, lo] = await plotLines(page, 'plot-cp');
      return { up: Math.max(...up.map((q) => q.y)), lo: Math.max(...lo.map((q) => q.y)), least: Math.min(...up.map((q) => q.y), ...lo.map((q) => q.y)) };
    };
    const cp4 = cpOf('4');
    const drawn4 = await drawnCp();
    expect(drawn4.up, 'the upper surface peaks upward (suction, −Cp > 0)').toBeGreaterThan(0.5);
    expect(drawn4.up).toBeGreaterThan(drawn4.lo + 0.3);
    for (const k of ['up', 'lo', 'least']) expect(Math.abs(drawn4[k] - cp4[k]), `${k}: drawn ${drawn4[k]}, XFOIL ${cp4[k]}`).toBeLessThan(0.03);
    // The plots keep near the kit's own width at any window size (it stretches its labels to fit).
    for (const size of [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size);
      const stretch = await ws.locator('svg.mgk-plot-svg').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width / 280));
      expect(stretch, `${size.width} px`).toHaveLength(4);
      for (const k of stretch) expect(k, `plot stretched ${k.toFixed(2)}× at ${size.width} px`).toBeLessThan(1.1);
      for (const k of stretch) expect(k, `plot squeezed ${k.toFixed(2)}× at ${size.width} px`).toBeGreaterThan(0.9);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: test.info().outputPath('plots-xfoil-2412.png'), fullPage: true });
    // Another angle for Cp(x): the plot follows and the study keeps it.
    await ws.locator('#af-cp-alpha').selectOption('0');
    await expect(ws.locator('[data-af="plot-cp"] figcaption')).toHaveText('Cp(x) at α = 0°');
    await expect.poll(() => study().view?.cp_alpha ?? null).toBe(0);
    const cp0 = cpOf('0');
    expect(Math.abs(cp0.up - cp4.up), 'XFOIL gives 0° and 4° different peaks').toBeGreaterThan(0.2);
    await expect.poll(async () => Math.abs((await drawnCp()).up - cp0.up)).toBeLessThan(0.03);
    const drawn0 = await drawnCp();
    for (const k of ['lo', 'least']) expect(Math.abs(drawn0[k] - cp0[k]), `0°, ${k}`).toBeLessThan(0.03);
    stage(t0, 'plots drawn');

    // The CSV: every row with its engine and settings.
    await expect(ws.locator('[data-af="export-csv"]')).toBeEnabled();
    const csv = await exportFile(page, ws, 'csv');
    expect(csv.name).toBe('NACA 2412 polar.csv');
    const csvLines = csv.text.trimEnd().split('\n');
    expect(csvLines[0]).toBe(CSV_HEADER);
    expect(csvLines).toHaveLength(1 + 15);
    const row4 = csvLines.find((l) => l.split(',')[8] === '4').split(',');
    expect(row4.slice(0, 10)).toEqual(['XFOIL', '', 'NACA 2412', '1000000', '0.2', '9', '0.1', '0.05', '4', 'converged']);
    expect(Number(row4[10]).toFixed(4)).toBe(cl4);
    stage(t0, 'CSV exported');

    // The overlay switch is saved (with one engine's results the plots are the same).
    await setSwitch(ws, 'af-overlay', false);
    await expect.poll(() => study().view?.overlay ?? null).toBe(false);

    // A .dat file through the file picker: clockwise, so it is reversed, and saved in the study.
    const clockwise = [datLines[0].replace('NACA 2412', 'My section'), ...datLines.slice(1).reverse()].join('\n') + '\n';
    const good = join(tmp, 'my-section.dat');
    writeFileSync(good, clockwise);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), ws.locator('[data-af="import-dat"]').click()]);
    await chooser.setFiles(good);
    await expect(ws.locator('.af-inputs')).toContainText('Imported: My section');
    await expect(ws.locator('.af-inputs')).toContainText('My section · thickness 12.00 %');
    await expect(ws.locator('.af-inputs')).toContainText('reversed');
    await expect(ws.locator('#af-pps')).toHaveCount(0);
    await expect(ws.locator('[data-af="naca"]')).toHaveAttribute('placeholder', 'My section');
    await expect.poll(() => study().airfoil).toEqual({ source: 'dat', name: 'My section', file: 'airfoil.dat' });
    expect(readFileSync(join(studyDir, 'airfoil.dat'), 'utf8').startsWith('My section\n')).toBe(true);
    await expect(ws.locator('[data-af="xfoil"]')).toContainText('These results are from other inputs. Run XFOIL again to update them.');
    // A file that is not one: its reason, named, and the study keeps the section it had.
    const bad = join(tmp, 'bad.dat');
    writeFileSync(bad, 'Bad\n1 0\nzz 1\n');
    const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), ws.locator('[data-af="import-dat"]').click()]);
    await chooser2.setFiles(bad);
    await expect(ws.locator('.af-inputs [role="alert"]')).toHaveText(/^bad\.dat: Line 3:/);
    expect(study().airfoil.name).toBe('My section');
    await page.screenshot({ path: test.info().outputPath('imported-section.png'), fullPage: true });
    stage(t0, '.dat imported, a bad one refused');

    // Reload: inputs, imported section, engine, overlay, Cp angle and the XFOIL polar come back.
    await page.reload();
    await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
    const again = frame(page);
    await expect(again.locator('.af-inputs')).toContainText('Imported: My section', { timeout: 60_000 });
    await expect(again.locator('.af-inputs')).toContainText('My section · thickness 12.00 %');
    await expect(again.locator('#af-engine')).toHaveValue('xfoil');
    await expect(again.locator('#af-overlay')).not.toBeChecked();
    await expect(again.locator('#af-forced')).toBeChecked();
    await expect(again.locator('#af-xtr-top')).toHaveValue('0.1');
    await expect(again.locator('#af-xtr-bottom')).toHaveValue('0.05');
    await expect(again.locator('#af-cp-alpha')).toHaveValue('0');
    await expect(again.locator('[data-af="plot-cp"] figcaption')).toHaveText('Cp(x) at α = 0°');
    await expect(again.locator('[data-af="xfoil-table"] tbody tr')).toHaveCount(15);
    await expect(again.locator('[data-af="plot-cl-alpha"] .mgk-plot-key')).toHaveText([legend]);
    stage(t0, 'reopened after a reload');
  } finally {
    host.stop();
  }
});

test('gate:h17-e2e NeuralFoil and XFOIL polars of NACA 2412 at Re 1e6, α −4…10°: warm redraw within 1 s, XFOIL on its golden, both engines overlaid, a failed angle listed, reopened after a reload', async ({
  page,
}) => {
  needEnv();
  test.skip(process.platform !== 'win32', "xfoil.exe is MIT's Windows build: it runs on Windows only");
  test.setTimeout(1_200_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const calls = recordServiceCalls(page);
  const tmp = e2eTemp('airfoil');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const golden = JSON.parse(readFileSync(resolve(GOLDEN), 'utf8'));
  const golden4 = golden.rows.find((r) => r.alpha === 4).cl;
  // The checkout's own bundled plugins and environment folder: the environment is built once.
  const host = await startHost({ name: 'airfoil', tmp, projects, enablePlugins: [KEY] });
  const { base } = host;
  try {
    stage(t0, `server up at ${base}`);
    await openProject(page, base, PROJECT);
    await installDependencies(page, 1_000_000);
    stage(t0, 'environment ready');
    const sid = await newStudyFromHeader(page, PROJECT);
    const ws = frame(page);
    const studyDir = join(projects, PROJECT, 'plugins', KEY, 'studies', sid);
    const nfTable = ws.locator('[data-af="neuralfoil-table"]');
    const nfCl = (alpha) => cellNumber(nfTable.locator(`tr[data-alpha="${alpha}"] [data-col="cl"]`));
    const nfLegend = (code) => `NeuralFoil (xlarge) · NACA ${code} · Re 1.00e+6 · Ncrit 9`;
    const clAlphaKeys = ws.locator('[data-af="plot-cl-alpha"] .mgk-plot-key');
    await expect(nfTable.locator('tbody tr')).toHaveCount(15, { timeout: 180_000 });
    // The service was warmed up as the page opened, before the first polar was asked for.
    expect(calls.indexOf('warmup'), `service calls: ${calls.join(', ')}`).toBeGreaterThan(-1);
    expect(calls.indexOf('warmup')).toBeLessThan(calls.indexOf('neuralfoil_polar'));
    expect(await nfCl(4)).toBeGreaterThan(0.65);
    expect(await nfCl(4)).toBeLessThan(0.78);
    expect(Math.abs(await nfCl(-2))).toBeLessThan(0.1);
    await expect(nfTable.locator('thead th')).toHaveText(['α', 'Cl', 'Cd', 'Cm', 'Cl/Cd', 'Confidence']);
    await expect(ws.locator('[data-af="neuralfoil"]')).toContainText('NACA 2412 · Re 1.00e+6');
    await expect(clAlphaKeys).toHaveText([nfLegend('2412')]);
    await page.screenshot({ path: test.info().outputPath('neuralfoil-2412.png'), fullPage: true });
    stage(t0, `study ${sid}: NeuralFoil polar shown`);

    // The key numbers read the shown polar: Cl max and the best Cl/Cd at the table's own
    // angles; −4…10° is short of NACA 2412's stall, so Cl max is "still rising".
    const nfRows = await nfTable.locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => {
        const cell = (c) => Number(tr.querySelector(`[data-col="${c}"]`).textContent.replace('−', '-'));
        return { alpha: Number(tr.dataset.alpha), cl: cell('cl'), ld: cell('cl_cd') };
      }),
    );
    const top = nfRows.reduce((a, b) => (b.cl > a.cl ? b : a));
    const best = nfRows.reduce((a, b) => (b.ld > a.ld ? b : a));
    const nfKeys = ws.locator('[data-af="key-neuralfoil"]');
    await expect(nfKeys).toContainText(new RegExp(`Cl max [0-9.]+ at ${top.alpha}°, still rising: no stall in −4°…10°`));
    await expect(nfKeys).toContainText(new RegExp(`Best Cl/Cd [0-9.]+ at ${best.alpha}°`));
    await expect(nfKeys).toContainText(/Zero-lift α −(1\.[5-9]|2\.[0-6])\d*°/);
    const slope = Number((await nfKeys.textContent()).match(/Lift slope ([0-9.]+) per degree/)[1]);
    expect(slope, 'lift slope per degree').toBeGreaterThan(0.09);
    expect(slope, 'lift slope per degree').toBeLessThan(0.125);
    // Each plot says how to read it, closed until asked for.
    for (const [af, words] of [
      ['plot-cl-alpha', 'The lift curve'],
      ['plot-cl-cd', 'The drag polar'],
      ['plot-cm-alpha', 'quarter-chord'],
    ]) {
      const help = ws.locator(`[data-af="${af}-help"]`);
      await expect(help.locator('p').first()).toBeHidden();
      await help.locator('summary').click();
      await expect(help).toContainText(words);
    }
    const nfColumns = ws.locator('[data-af="neuralfoil-columns-help"]');
    await nfColumns.locator('summary').click();
    await expect(nfColumns).toContainText('Confidence: how sure NeuralFoil is');
    await expect(ws.locator('[data-af="neuralfoil-about"]')).toContainText('trained on XFOIL results');
    stage(t0, `key numbers: Cl max at ${top.alpha}°, best Cl/Cd at ${best.alpha}°, slope ${slope}/°; the folds open`);
    const saved = JSON.parse(readFileSync(join(studyDir, 'results', 'neuralfoil.json'), 'utf8'));
    expect(saved.rows).toHaveLength(15);

    // Warm: each input change redraws the polar within 1 s, from Enter to the new numbers in
    // the table and the new section in the plot's legend.
    const redraws = [];
    for (const [code, check] of [
      ['4412', (cl) => cl > 0.85],
      ['2412', (cl) => cl > 0.65 && cl < 0.78],
      ['4412', (cl) => cl > 0.85],
    ]) {
      const naca = ws.locator('[data-af="naca"]');
      await naca.fill(code);
      const sent = Date.now();
      await naca.press('Enter');
      await expect(ws.locator('[data-af="neuralfoil"]')).toContainText(`NACA ${code} · Re`, { timeout: 10_000 });
      await expect.poll(async () => check(await nfCl(4)), { intervals: [20], timeout: 10_000 }).toBe(true);
      await expect(clAlphaKeys).toHaveText([nfLegend(code)], { timeout: 10_000 });
      redraws.push(Date.now() - sent);
    }
    stage(t0, `warm NeuralFoil redraws: ${redraws.join(', ')} ms`);
    expect(Math.max(...redraws), `warm redraws took ${redraws.join(', ')} ms`).toBeLessThan(WARM_REDRAW_MS);
    await commitField(ws, 'af-naca', '2412');
    await expect(ws.locator('[data-af="neuralfoil"]')).toContainText('NACA 2412 · Re');
    // Mach changes NeuralFoil's polar, so the legend names it once it is set.
    await commitField(ws, 'af-mach', 0.2);
    await expect(clAlphaKeys).toHaveText(['NeuralFoil (xlarge) · NACA 2412 · Re 1.00e+6 · Mach 0.2 · Ncrit 9'], { timeout: 10_000 });
    await commitField(ws, 'af-mach', 0);
    await expect(clAlphaKeys).toHaveText([nfLegend('2412')], { timeout: 10_000 });

    // XFOIL, the shipped program: Cl at 4° within 2 % of the golden, every angle converged.
    await ws.locator('#af-engine').selectOption('xfoil');
    const xfTable = ws.locator('[data-af="xfoil-table"]');
    await ws.locator('[data-af="run-xfoil"]').click();
    await expect(xfTable.locator('tbody tr')).toHaveCount(15, { timeout: 120_000 });
    await expect(ws.locator('[data-af="xfoil"]')).toContainText('NACA 2412 · Re 1.00e+6 · Ncrit 9 · 15 of 15 angles converged');
    await expect(ws.locator('[data-af="xfoil-not-converged"]')).toHaveCount(0);
    const xfCl4 = await cellNumber(xfTable.locator('tr[data-alpha="4"] [data-col="cl"]'));
    expect(Math.abs(xfCl4 - golden4) / golden4, `XFOIL Cl(4°) ${xfCl4}, golden ${golden4}`).toBeLessThan(0.02);
    stage(t0, `XFOIL Cl(4°) = ${xfCl4} (golden ${golden4})`);
    const xfColumns = ws.locator('[data-af="xfoil-columns-help"]');
    await xfColumns.locator('summary').click();
    await expect(xfColumns).toContainText('Transition (top): where the boundary layer');
    await expect(ws.locator('[data-af="key-xfoil"]')).toContainText(/Cl max [0-9.]+ at 10°, still rising/);

    // Both engines on every polar plot, each named with its settings; the tip reads both at 4°.
    const xfLegend = 'XFOIL · NACA 2412 · Re 1.00e+6 · Ncrit 9';
    for (const af of ['plot-cl-alpha', 'plot-cl-cd', 'plot-cm-alpha']) {
      await expect(ws.locator(`[data-af="${af}"] polyline.mgk-plot-line`)).toHaveCount(2);
      await expect(ws.locator(`[data-af="${af}"] .mgk-plot-key`)).toHaveText([nfLegend('2412'), xfLegend]);
    }
    const tip = await plotTip(ws, 'plot-cl-alpha', ALPHA4_ON_MINUS5_TO_10);
    expect(tip).toContain('α = 4°');
    expect(tip).toContain(`XFOIL ${xfCl4.toFixed(4)}`);
    expect(tip).toMatch(/NeuralFoil \(xlarge\) 0\.\d{4}/);
    await page.screenshot({ path: test.info().outputPath('overlay-2412.png'), fullPage: true });
    // The overlay off: only the picked engine (XFOIL) is drawn.
    await setSwitch(ws, 'af-overlay', false);
    await expect(clAlphaKeys).toHaveText([xfLegend]);
    await setSwitch(ws, 'af-overlay', true);
    await expect(clAlphaKeys).toHaveText([nfLegend('2412'), xfLegend]);
    // The CSV carries both engines.
    const csv = await exportFile(page, ws, 'csv');
    const engines = csv.text
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((l) => l.split(',')[0]);
    expect(engines.filter((e) => e === 'NeuralFoil')).toHaveLength(15);
    expect(engines.filter((e) => e === 'XFOIL')).toHaveLength(15);
    stage(t0, 'both engines overlaid and exported');

    // An angle XFOIL does not converge is listed, never dropped: NACA 0012, Re 1e5, α 10…20°.
    await commitField(ws, 'af-naca', '0012');
    await commitField(ws, 'af-re', 100000);
    await commitField(ws, 'af-a1', 20);
    await commitField(ws, 'af-a0', 10);
    await expect.poll(() => JSON.parse(readFileSync(join(studyDir, 'study.json'), 'utf8')).conditions?.alpha_start ?? null).toBe(10);
    await expect(ws.locator('[data-af="xfoil"]')).toContainText('These results are from other inputs. Run XFOIL again to update them.');
    const progress = await recordProgress(page);
    await ws.locator('[data-af="run-xfoil"]').click();
    await expect(ws.locator('[data-af="xfoil-not-converged"] li')).toHaveText(['α = 18°: did not converge'], { timeout: 120_000 });
    await expect(xfTable.locator('tr.af-missing[data-alpha="18"]')).toContainText('did not converge');
    await expect(ws.locator('[data-af="xfoil"]')).toContainText('NACA 0012 · Re 1.00e+5 · Ncrit 9 · 10 of 11 angles converged');
    const lines = await progress();
    stage(t0, `XFOIL: α = 18° listed as not converged; progress lines seen: ${JSON.stringify(lines)}`);
    expect(lines.filter((l) => / of 11$/.test(l)).length, 'per-angle progress').toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath('xfoil-0012-failed-angle.png'), fullPage: true });
    const xfSaved = JSON.parse(readFileSync(join(studyDir, 'results', 'xfoil.json'), 'utf8'));
    expect(xfSaved.not_converged).toEqual([18]);
    await expect.poll(() => JSON.parse(readFileSync(join(studyDir, 'results', 'neuralfoil.json'), 'utf8')).rows.length).toBe(11);

    // Reload: the inputs, both polars and the failed angle come back as they were saved:
    // NeuralFoil's polar is the saved one, not computed again.
    const nfSaved = () => JSON.parse(readFileSync(join(studyDir, 'results', 'neuralfoil.json'), 'utf8'));
    const nfBefore = nfSaved();
    const callsBefore = calls.length;
    await page.reload();
    await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
    const again = frame(page);
    await expect(again.locator('[data-af="naca"]')).toHaveValue('0012', { timeout: 60_000 });
    await expect(again.locator('#af-engine')).toHaveValue('xfoil');
    await expect(again.locator('[data-af="xfoil-not-converged"] li')).toHaveText(['α = 18°: did not converge']);
    await expect(again.locator('[data-af="xfoil"]')).toContainText('10 of 11 angles converged');
    await expect(again.locator('[data-af="xfoil-table"] tbody tr')).toHaveCount(11);
    await expect(again.locator('[data-af="plot-cl-alpha"] polyline.mgk-plot-line')).toHaveCount(2);
    await again.locator('#af-engine').selectOption('neuralfoil');
    await expect(again.locator('[data-af="neuralfoil-table"] tbody tr')).toHaveCount(11, { timeout: 60_000 });
    await expect(again.locator('[data-af="neuralfoil"]')).toContainText(`${Math.round(nfBefore.seconds * 1000)} ms`);
    expect(calls.slice(callsBefore), 'the reopened page computed NeuralFoil again').not.toContain('neuralfoil_polar');
    expect(nfSaved().computed_at).toBe(nfBefore.computed_at);
    stage(t0, 'reopened after a reload');
  } finally {
    host.stop();
  }
});

// OpenFOAM 2D runs as the study keeps them (results/openfoam.json, one case folder per run):
// a done steady run is its point, a failed one keeps its reason, and the defaults the panel
// opens on. The seeded numbers are real runs' (NACA 2412, Re 1e6, medium mesh; at 4° the run of
// tests/fixtures/openfoam/coefficient.dat).
function seededRuns() {
  const airfoil = { source: 'naca', code: '2412', points_per_side: 81, closed_te: false };
  const conditions = { re: 1e6, mach: 0, alpha_start: -4, alpha_end: 10, alpha_step: 1, ncrit: 9, xtr_top: 1, xtr_bottom: 1 };
  const base = { name: 'NACA 2412', airfoil, conditions, level: 'medium', cells: 28_000, error: '', code: '' };
  return [
    { ...base, case_rel: 'openfoam/run-1-a4', alpha: 4, compute_id: 'fc-seed01-000001', status: 'done', written_at: '2026-10-02T10:00:00+00:00', finished_at: '2026-10-02T10:01:00+00:00', cl: 0.6256, cd: 0.01343, cm: -0.0433, cl_cd: 46.57, cl_change: 0.0001, iterations: 1500, averaged: 200, steady: true, residuals: { U: 9.28e-5, p: 0.000597, omega: 6.45e-9, k: 9.81e-6 } },
    { ...base, case_rel: 'openfoam/run-2-a0', alpha: 0, compute_id: 'fc-seed01-000002', status: 'done', written_at: '2026-10-02T10:02:00+00:00', finished_at: '2026-10-02T10:03:00+00:00', cl: 0.2099, cd: 0.01107, cm: -0.0466, cl_cd: 18.96, cl_change: 0.0001, iterations: 1500, averaged: 200, steady: true, residuals_met: null },
    { ...base, case_rel: 'openfoam/run-3-a8', alpha: 8, compute_id: 'fc-seed01-000003', status: 'failed', written_at: '2026-10-02T10:04:00+00:00', finished_at: '2026-10-02T10:04:30+00:00', error: 'gmshToFoam failed (exit 1). See log.gmshToFoam.1 in the case folder', code: '' },
  ];
}

test('the Airfoil workspace: OpenFOAM 2D runs listed, plotted, exported and deleted, its reasons honest, all reopened', async ({ page }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const { host, projects } = await startEngineLessHost('airfoil-of-seeded');
  const { base } = host;
  try {
    await openProject(page, base, PROJECT);
    await installDependencies(page, 180_000);
    const sid = await newStudyFromHeader(page, PROJECT);
    let ws = frame(page);
    await expect(ws.locator('[data-af="outline"]')).toBeVisible({ timeout: 60_000 });
    const studyDir = join(projects, PROJECT, 'plugins', KEY, 'studies', sid);
    const study = () => JSON.parse(readFileSync(join(studyDir, 'study.json'), 'utf8'));
    stage(t0, `study ${sid} opened`);

    // OpenFOAM 2D in the picker; the panel opens on 4° and the medium mesh, nothing run yet.
    await ws.locator('#af-engine').selectOption('openfoam');
    await expect.poll(() => study().view?.engine ?? null).toBe('openfoam');
    const panel = ws.locator('[data-af="openfoam"]');
    await expect(ws.locator('#af-of-alpha')).toHaveValue('4');
    await expect(ws.locator('#af-of-level')).toHaveValue('medium');
    await expect(ws.locator('#af-of-level option')).toHaveText(['Coarse', 'Medium', 'Fine']);
    await expect(panel).toContainText('A structured C-mesh, y+ about 1 at the wall; 1500 iterations');
    await expect(panel).toContainText('No OpenFOAM run yet');
    await expect(ws.locator('[data-af="table"]')).toContainText('No OpenFOAM polar yet');
    await expect(panel).toContainText('It runs fully turbulent: compare it with XFOIL with forced transition.');
    // This environment has no Gmsh: Run says so and how to fix it.
    const run = ws.locator('[data-af="run-openfoam"]');
    await expect(run).toBeDisabled();
    await expect(panel).toContainText("Gmsh is not installed in the Airfoil plugin's environment. Open Settings → Plugins and click Install dependencies.");
    // A Reynolds number OpenFOAM's fully turbulent model is not for: its reason, and the fix goes to the field.
    await commitField(ws, 'af-re', 50000);
    await expect(panel).toContainText('OpenFOAM 2D runs fully turbulent (k-ω SST): use a Reynolds number from 1e5 to 5e7.');
    await panel.getByRole('button', { name: 'Change the Reynolds number' }).click();
    await expect(ws.locator('#af-re')).toBeFocused();
    await commitField(ws, 'af-re', 1000000);
    await expect(panel).not.toContainText('use a Reynolds number from');
    // Mach is not OpenFOAM 2D's: it says so while Mach is set.
    await commitField(ws, 'af-mach', 0.2);
    await expect(panel).toContainText('OpenFOAM 2D is incompressible: the Mach number is not used.');
    await commitField(ws, 'af-mach', 0);
    await expect(panel).not.toContainText('incompressible');
    // Angle and mesh are kept with the study.
    await commitField(ws, 'af-of-alpha', 6.5);
    await ws.locator('#af-of-level').selectOption('fine');
    await expect.poll(() => study().view?.of_alpha ?? null).toBe(6.5);
    await expect.poll(() => study().view?.of_level ?? null).toBe('fine');
    await expect(panel).toContainText('2500 iterations');
    await ws.locator('#af-of-level').selectOption('medium');
    await expect.poll(() => study().view?.of_level ?? null).toBe('medium');
    await expect.poll(() => study().conditions?.re ?? null).toBe(1e6);
    stage(t0, 'reasons and inputs');

    // Three runs as the study keeps them, two done and one failed; reopened, the page lists them.
    for (const r of seededRuns()) {
      mkdirSync(join(studyDir, ...r.case_rel.split('/'), 'system'), { recursive: true });
      writeFileSync(join(studyDir, ...r.case_rel.split('/'), 'case.json'), JSON.stringify({ case_rel: r.case_rel, alpha: r.alpha }));
    }
    mkdirSync(join(studyDir, 'results'), { recursive: true });
    writeFileSync(join(studyDir, 'results', 'openfoam.json'), JSON.stringify({ engine: 'openfoam', runs: seededRuns() }));
    await page.reload();
    await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
    ws = frame(page);
    const runs = ws.locator('[data-af="openfoam-runs"] tbody tr');
    await expect(runs).toHaveCount(3, { timeout: 60_000 });
    await expect(ws.locator('#af-engine')).toHaveValue('openfoam');
    await expect(ws.locator('#af-of-alpha')).toHaveValue('6.5');
    // Newest first: α, mesh, the coefficients of a done run, how each one stands.
    await expect(runs.nth(0).locator('td')).toHaveText(['8°', 'medium', '—', '—', '—', 'Failed: gmshToFoam failed (exit 1). See log.gmshToFoam.1 in the case folder', 'Delete']);
    await expect(runs.nth(1).locator('td')).toHaveText(['0°', 'medium', '0.2099', '0.01107', '−0.0466', 'Steady', 'Open in 3DDelete']);
    // A run that kept its last residuals says how far the solver got (p levels off while Cl settles).
    await expect(runs.nth(2).locator('td')).toHaveText(['4°', 'medium', '0.6256', '0.01343', '−0.0433', 'Steady · largest residual 6.0e−4 (p)', 'Open in 3DDelete']);
    // The polar of these inputs: the two done angles, in the table and as a line named with its settings.
    const table = ws.locator('[data-af="openfoam-table"]');
    await expect(ws.locator('[data-af="table"] h2')).toHaveText('OpenFOAM 2D polar');
    await expect(table.locator('thead th')).toHaveText(['α', 'Cl', 'Cd', 'Cm', 'Cl/Cd', 'Iterations']);
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.locator('tr[data-alpha="4"] [data-col="cl"]')).toHaveText('0.6256');
    await expect(table.locator('tr[data-alpha="4"] [data-col="iterations"]')).toHaveText('1500');
    const ofLegend = 'OpenFOAM 2D (k-ω SST, medium mesh) · NACA 2412 · Re 1.00e+6';
    for (const af of ['plot-cl-alpha', 'plot-cl-cd', 'plot-cm-alpha']) {
      await expect(ws.locator(`[data-af="${af}"] polyline.mgk-plot-line`)).toHaveCount(1);
      await expect(ws.locator(`[data-af="${af}"] .mgk-plot-key`)).toHaveText([ofLegend]);
    }
    // Another mesh level is another polar: none here yet.
    await ws.locator('#af-of-level').selectOption('coarse');
    await expect(table).toHaveCount(0);
    await expect(ws.locator('[data-af="table"]')).toContainText('No OpenFOAM polar yet');
    await expect(ws.locator('[data-af="plots"]')).toContainText('No polar yet');
    await ws.locator('#af-of-level').selectOption('medium');
    await expect(table.locator('tbody tr')).toHaveCount(2);
    // The CSV carries every run, the failed one with how it ended and no numbers.
    const csv = await exportFile(page, ws, 'csv');
    const rows = csv.text.trimEnd().split('\n');
    expect(rows[0]).toBe(CSV_HEADER);
    const ofRows = rows.filter((l) => l.startsWith('OpenFOAM 2D,'));
    expect(ofRows).toEqual([
      'OpenFOAM 2D,"k-ω SST, medium mesh",NACA 2412,1000000,,,,,0,steady,0.2099,0.01107,-0.0466,18.96,,,',
      'OpenFOAM 2D,"k-ω SST, medium mesh",NACA 2412,1000000,,,,,4,steady,0.6256,0.01343,-0.0433,46.57,,,',
      'OpenFOAM 2D,"k-ω SST, medium mesh",NACA 2412,1000000,,,,,8,failed,,,,,,,',
    ]);
    stage(t0, 'seeded runs listed, plotted and exported');

    // One point only: its numbers are in the table, and the plots say so (one point draws no line).
    // Delete the 0° run: the app asks first; Cancel keeps it, Delete removes it and its folder.
    await runs.nth(1).getByRole('button', { name: 'Delete' }).click();
    const modal = page.locator('#modal-confirm');
    await expect(modal).toBeVisible();
    await expect(page.locator('#cf-heading')).toHaveText('Delete the OpenFOAM run at α = 0°?');
    await expect(page.locator('#cf-copy')).toHaveText('Its case folder (openfoam/run-2-a0) and its result go. This cannot be undone.');
    await page.locator('#cf-cancel').click();
    await expect(runs).toHaveCount(3);
    await runs.nth(1).getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#cf-confirm')).toHaveText('Delete');
    await page.locator('#cf-confirm').click();
    await expect(runs).toHaveCount(2);
    expect(existsSync(join(studyDir, 'openfoam', 'run-2-a0'))).toBe(false);
    expect(JSON.parse(readFileSync(join(studyDir, 'results', 'openfoam.json'), 'utf8')).runs.map((r) => r.case_rel)).toEqual([
      'openfoam/run-1-a4',
      'openfoam/run-3-a8',
    ]);
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(ws.locator('[data-af="plots"]')).toContainText(
      'OpenFOAM 2D has one angle so far (α = 4°): its numbers are in its table. Run another angle to draw its line.',
    );
    // The overlay off and another engine picked: OpenFOAM leaves the plots.
    await setSwitch(ws, 'af-overlay', false);
    await ws.locator('#af-engine').selectOption('xfoil');
    await expect(ws.locator('[data-af="plots"]')).not.toContainText('OpenFOAM 2D has one angle');
    await ws.locator('#af-engine').selectOption('openfoam');
    await setSwitch(ws, 'af-overlay', true);
    await page.screenshot({ path: test.info().outputPath('openfoam-seeded.png'), fullPage: true });

    // Reload: the two runs and the polar come back as they were.
    await page.reload();
    await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
    ws = frame(page);
    await expect(ws.locator('[data-af="openfoam-runs"] tbody tr')).toHaveCount(2, { timeout: 60_000 });
    await expect(ws.locator('[data-af="openfoam-table"] tbody tr')).toHaveCount(1);
    await expect(ws.locator('[data-af="plot-cl-alpha"] .mgk-plot-key')).toHaveText([ofLegend]);
    stage(t0, 'a run deleted; reopened after a reload');
  } finally {
    host.stop();
  }
});

test('gate:h17-openfoam-2d OpenFOAM 2D of NACA 2412 at Re 1e6: queued on the compute slot, residuals as it solves, Cl at 4° within 10 % of XFOIL with forced transition, a queued case stopped, reopened, opened in 3D', async ({
  page,
  request,
}) => {
  test.skip(!WSL, NO_WSL);
  needEnv();
  test.skip(process.platform !== 'win32', "xfoil.exe is MIT's Windows build: it runs on Windows only");
  test.setTimeout(1_800_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const release = await acquireWslLock({ what: 'airfoil gate:h17-openfoam-2d', log: (m) => stage(t0, m) });
  const tmp = e2eTemp('airfoil-of');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const wslRoot = `/tmp/magnusim-e2e-airfoil-of-${process.pid}/cases`;
  const host = await startHost({
    name: 'airfoil-of',
    tmp,
    projects,
    enablePlugins: [KEY],
    env: { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot },
  });
  const { base } = host;
  try {
    const queue = async () => (await computeQueue(request, { base })) || { items: [], busy: null, failed: [] };
    stage(t0, `server up at ${base}`);
    await openProject(page, base, PROJECT);
    await installDependencies(page, 1_000_000);
    const sid = await newStudyFromHeader(page, PROJECT);
    let ws = frame(page);
    const studyDir = join(projects, PROJECT, 'plugins', KEY, 'studies', sid);
    await expect(ws.locator('[data-af="outline"]')).toBeVisible({ timeout: 60_000 });

    // XFOIL with transition forced at 5 % of the chord on both surfaces: OpenFOAM's k-ω SST is fully turbulent.
    await setSwitch(ws, 'af-forced', true);
    await expect(ws.locator('#af-xtr-top')).toHaveValue('0.05');
    await expect.poll(() => JSON.parse(readFileSync(join(studyDir, 'study.json'), 'utf8')).conditions?.xtr_top ?? null).toBe(0.05);
    await ws.locator('#af-engine').selectOption('xfoil');
    const xfTable = ws.locator('[data-af="xfoil-table"]');
    await ws.locator('[data-af="run-xfoil"]').click();
    await expect(ws.locator('[data-af="xfoil"]')).toContainText('trip 0.05/0.05 · ', { timeout: 120_000 });
    const xfCl4 = await cellNumber(xfTable.locator('tr[data-alpha="4"] [data-col="cl"]'));
    stage(t0, `XFOIL with forced transition: Cl(4°) = ${xfCl4}`);

    // OpenFOAM 2D at 4°: the case is written (meshed with Gmsh), queued and run in WSL.
    await ws.locator('#af-engine').selectOption('openfoam');
    const panel = ws.locator('[data-af="openfoam"]');
    const runButton = ws.locator('[data-af="run-openfoam"]');
    await expect(runButton).toBeEnabled({ timeout: 60_000 });
    await expect(ws.locator('#af-of-alpha')).toHaveValue('4');
    await runButton.click();
    await expect(ws.locator('[data-af="openfoam-writing"]')).toBeVisible();
    const runs = ws.locator('[data-af="openfoam-runs"] tbody tr');
    const row = (rel) => ws.locator(`[data-af="openfoam-runs"] tr[data-case="${rel}"]`);
    await expect(row('openfoam/run-1-a4')).toHaveCount(1, { timeout: 120_000 });
    await expect(ws.locator('[data-af="openfoam-writing"]')).toHaveCount(0);
    const progress = ws.locator('[data-af="openfoam-progress"]');
    await expect(progress).toBeVisible();
    // While it runs, two more angles: they wait in the queue behind it.
    await commitField(ws, 'af-of-alpha', 0);
    await runButton.click();
    await expect(row('openfoam/run-2-a0')).toHaveCount(1, { timeout: 120_000 });
    await expect(ws.locator('[data-af="openfoam-writing"]')).toHaveCount(0);
    await commitField(ws, 'af-of-alpha', 8);
    await runButton.click();
    await expect(row('openfoam/run-3-a8')).toHaveCount(1, { timeout: 120_000 });
    const records = () => foamRecords(projects).filter((r) => r.plugin === KEY);
    await expect.poll(() => records().length, { timeout: 30_000 }).toBe(3);
    const id = (rel) => records().find((r) => r.case_rel === rel || String(r.case_dir || '').replace(/\\/g, '/').endsWith(rel))?.id;
    const q = await queue();
    expect(q.busy?.kind, JSON.stringify(q)).toBe('foam');
    expect(q.items.filter((r) => r.kind === 'foam').map((r) => r.job_id)).toEqual([id('openfoam/run-2-a0'), id('openfoam/run-3-a8')]);
    await expect(row('openfoam/run-2-a0').locator('[data-col="status"]')).toHaveText(/^Queued: /);
    await expect(row('openfoam/run-3-a8').locator('[data-col="status"]')).toHaveText(/^Queued: /);
    stage(t0, `queue: running ${q.busy?.job_id}, waiting ${q.items.map((r) => r.job_id).join(', ')}`);
    // The last one leaves the queue before it starts.
    await row('openfoam/run-3-a8').getByRole('button', { name: 'Stop' }).click();
    await expect(row('openfoam/run-3-a8').locator('[data-col="status"]')).toHaveText('Stopped: Removed from the queue before it started', { timeout: 60_000 });
    expect((await queue()).items.map((r) => r.job_id)).toEqual([id('openfoam/run-2-a0')]);
    // Residuals as it solves: one line per field, iterations along x.
    await expect(progress.locator('[data-af="openfoam-residuals"] polyline.mgk-plot-line').first()).toBeVisible({ timeout: 300_000 });
    await expect
      .poll(async () => (await progress.locator('.mgk-plot-key').allTextContents()).sort(), { timeout: 60_000 })
      .toEqual(['Ux', 'Uy', 'k', 'omega', 'p']);
    await expect(progress.locator('.mgk-status-line')).toHaveText(/^α = 4° · Running: iteration \d+$/);
    await page.screenshot({ path: test.info().outputPath('openfoam-running.png'), fullPage: true });
    stage(t0, 'residuals shown while 4° solves');
    // A reload while 4° solves and 0° waits: the page follows both again, residuals and all.
    await page.reload();
    await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
    ws = frame(page);
    await expect(row('openfoam/run-2-a0').locator('[data-col="status"]')).toHaveText(/^Queued: /, { timeout: 60_000 });
    await expect(row('openfoam/run-1-a4').locator('[data-col="status"]')).toHaveText(/^Running: iteration \d+$/);
    await expect(progress.locator('[data-af="openfoam-residuals"] polyline.mgk-plot-line').first()).toBeVisible();
    await expect(row('openfoam/run-3-a8').locator('[data-col="status"]')).toHaveText('Stopped: Removed from the queue before it started');
    stage(t0, 'reopened while 4° solves: followed again');

    // 4° ends, then 0° runs from the queue; both done and steady.
    await expect(row('openfoam/run-1-a4')).toHaveAttribute('data-status', 'done', { timeout: 900_000 });
    await expect(row('openfoam/run-1-a4').locator('[data-col="status"]')).toHaveText(/^Steady · largest residual \d\.\de−\d \(p\)$/);
    stage(t0, '4° done');
    await expect(row('openfoam/run-2-a0')).toHaveAttribute('data-status', 'done', { timeout: 900_000 });
    await expect(row('openfoam/run-2-a0').locator('[data-col="status"]')).toHaveText(/^Steady · largest residual \d\.\de−\d \(p\)$/);
    await expect(progress).toHaveCount(0);
    stage(t0, '0° done');
    // The host ran each case in its own WSL folder, named for this plugin.
    for (const rec of records().filter((r) => r.status === 'done')) expect(rec.wsl_case).toMatch(/^cfddesk-pf-airfoil-/);

    // gate:h17-openfoam-2d: Cl at 4° within 10 % of XFOIL with forced transition.
    const table = ws.locator('[data-af="openfoam-table"]');
    await expect(table.locator('tbody tr')).toHaveCount(2);
    const ofCl4 = await cellNumber(table.locator('tr[data-alpha="4"] [data-col="cl"]'));
    stage(t0, `OpenFOAM Cl(4°) = ${ofCl4}, XFOIL forced ${xfCl4}: ${(((ofCl4 - xfCl4) / xfCl4) * 100).toFixed(1)} %`);
    expect(Math.abs(ofCl4 - xfCl4) / xfCl4, `OpenFOAM ${ofCl4}, XFOIL ${xfCl4}`).toBeLessThan(0.1);
    const saved = JSON.parse(readFileSync(join(studyDir, 'results', 'openfoam.json'), 'utf8'));
    expect(saved.runs.map((r) => [r.case_rel, r.status])).toEqual([
      ['openfoam/run-1-a4', 'done'],
      ['openfoam/run-2-a0', 'done'],
      ['openfoam/run-3-a8', 'stopped'],
    ]);
    expect(saved.runs[0].cl).toBeCloseTo(ofCl4, 4);
    // How far the solver got at 4°: p levels off near 6e-4, the rest far below.
    expect(saved.runs[0].residuals.p, JSON.stringify(saved.runs[0].residuals)).toBeLessThan(2e-3);
    expect(saved.runs[0].residuals.U).toBeLessThan(1e-4);
    // What came back from WSL: the mesh the steps made, the force coefficients, the last frame.
    const caseDir = join(studyDir, 'openfoam', 'run-1-a4');
    expect(readFileSync(join(caseDir, 'constant', 'polyMesh', 'boundary'), 'latin1')).toMatch(/airfoil\s*\{\s*type\s+wall;/);
    expect(existsSync(join(caseDir, 'postProcessing', 'forceCoeffs', '0', 'coefficient.dat'))).toBe(true);
    expect(existsSync(join(caseDir, '1500', 'U'))).toBe(true);
    // Every engine on the plots, OpenFOAM's line through its two angles.
    const ofLegend = 'OpenFOAM 2D (k-ω SST, medium mesh) · NACA 2412 · Re 1.00e+6';
    await expect(ws.locator('[data-af="plot-cl-alpha"] .mgk-plot-key')).toContainText([ofLegend]);
    await expect(ws.locator('[data-af="plot-cl-alpha"] polyline.mgk-plot-line')).toHaveCount(3);
    await page.screenshot({ path: test.info().outputPath('openfoam-done.png'), fullPage: true });

    // Reload: the runs, the polar and the picked engine come back.
    await page.reload();
    await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
    ws = frame(page);
    await expect(ws.locator('#af-engine')).toHaveValue('openfoam', { timeout: 60_000 });
    await expect(ws.locator('[data-af="openfoam-runs"] tbody tr')).toHaveCount(3, { timeout: 60_000 });
    await expect(ws.locator('[data-af="openfoam-table"] tr[data-alpha="4"] [data-col="cl"]')).toHaveText(ofCl4.toFixed(4));
    stage(t0, 'reopened after a reload');

    // Open in 3D: the workspace closes and the project's viewer shows the case's frames.
    await ws.locator('[data-af="openfoam-runs"] tr[data-case="openfoam/run-1-a4"]').getByRole('button', { name: 'Open in 3D' }).click();
    await expect(overlay(page)).toBeHidden({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}$`));
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    await expect.poll(() => page.evaluate(() => window.__CFD_W6__?.case_dir || ''), { timeout: 60_000 }).toContain('run-1-a4');
    await expect
      .poll(() => page.evaluate(() => (window.__CFD_W12__?.available_times || []).map(String)), { timeout: 60_000 })
      .toEqual(['0', '1500']);
    await page.screenshot({ path: test.info().outputPath('openfoam-in-3d.png') });
    stage(t0, 'opened in 3D');
  } finally {
    // Kept with the test's results: what each run wrote (its record, coefficients and solver log).
    const studies = join(projects, PROJECT, 'plugins', KEY, 'studies');
    if (existsSync(studies)) {
      cpSync(studies, test.info().outputPath('studies'), {
        recursive: true,
        filter: (src) => !/[\\/](mesh\.msh|constant|0|[1-9]\d*|processor\d+)$/.test(src),
      });
    }
    writeFileSync(test.info().outputPath('host.log'), host.log ? host.log() : '');
    for (const line of killFoamRelays(projects)) stage(t0, `relay kill ${line}`);
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[airfoil] WSL root not removed: ${e.message}`);
    }
    release();
  }
});

test('gate:h17-disable-and-remove the Airfoil folder removed: the project opens without it, its study greyed and named, no byte changed; the folder back, the study reopens', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  // Kept across the three servers (each removes its own temp folder when it stops).
  const keep = e2eTemp('airfoil-rm');
  const projects = join(keep, 'projects');
  prepareE2eProjectsRoot(projects);
  const envs = join(keep, 'envs');
  const projectDir = join(projects, PROJECT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    // A project with an Airfoil study: NACA 0012, the XFOIL engine picked.
    let { host } = await startEngineLessHost('airfoil-rm1', { projects, envs });
    let sid;
    try {
      await openProject(page, host.base, PROJECT);
      await installDependencies(page, 180_000);
      sid = await newStudyFromHeader(page, PROJECT);
      const ws = frame(page);
      await expect(ws.locator('[data-af="outline"]')).toBeVisible({ timeout: 60_000 });
      await commitField(ws, 'af-naca', '0012');
      await ws.locator('#af-engine').selectOption('xfoil');
      const studyFile = join(projectDir, 'plugins', KEY, 'studies', sid, 'study.json');
      await expect.poll(() => JSON.parse(readFileSync(studyFile, 'utf8')).view?.engine ?? null).toBe('xfoil');
      await expect.poll(() => JSON.parse(readFileSync(studyFile, 'utf8')).airfoil?.code ?? null).toBe('0012');
      await overlay(page).locator('[data-ws-back]').click();
      await expect(overlay(page)).toBeHidden();
    } finally {
      host.stop();
    }
    stage(t0, `study ${sid} made; the app stopped`);
    const before = hashTree(projectDir);
    expect(Object.keys(before).some((k) => k.includes(join('plugins', KEY, 'studies', sid)))).toBe(true);

    // The app on bundled plugins without the Airfoil folder.
    // A new page load (the next server may get the same port: the same URL would not reload).
    await page.goto('about:blank');
    ({ host } = await startEngineLessHost('airfoil-rm2', { projects, envs, airfoil: false }));
    errors.length = 0;
    try {
      // The registry: Incompressible Flow loaded with its analysis, nothing of Airfoil.
      const registry = await (await page.request.get(`${host.base}/api/registry`)).json();
      expect(registry.required_missing || []).toEqual([]);
      expect((registry.analysis || []).map((r) => r.key)).toContain('incompressible_steady');
      expect(JSON.stringify(registry)).not.toContain('airfoil_analysis');
      await openProject(page, host.base, PROJECT);
      // Incompressible Flow, the core's own analysis, is there; Airfoil's launchers are not.
      await expect(page.locator(`#ws-start-host [data-start-header="${START}"]`)).toHaveCount(0);
      await expect(page.locator(`#wb-empty-start [data-start-empty="${START}"]`)).toHaveCount(0);
      // The study stays listed, greyed, with what it needs and where to get it.
      const row = page.locator(`#plugin-studies-section [data-plugin-study="${sid}"]`);
      await expect(row).toHaveClass(/is-unavailable/, { timeout: 30_000 });
      await expect(row).toContainText('Airfoil analysis 1');
      await expect(page.locator('#plugin-studies-section')).toContainText('Requires the Airfoil plugin');
      await page.screenshot({ path: test.info().outputPath('removed-project.png') });
      // A link to the study: the workspace does not open, and nothing is written.
      await page.goto(`${host.base}/#/p/${PROJECT}/ws/${KEY}/polar/${sid}`);
      await expect(page.locator('body')).toContainText('not installed', { timeout: 30_000 });
      // It names the plugin and the study as the project tree does, not the key and the id.
      await expect(overlay(page).locator('[data-ws-error] h2')).toHaveText('The Airfoil plugin is not installed.');
      await expect(overlay(page).locator('[data-ws-crumb]')).toHaveText(/^Airfoil\s*›\s*Airfoil analysis 1$/);
      await expect(overlay(page)).not.toContainText(sid);
      await page.screenshot({ path: test.info().outputPath('removed-direct-link.png') });
      await openProject(page, host.base, PROJECT);
      await expect(row).toHaveClass(/is-unavailable/, { timeout: 30_000 });
      expect(errors, 'page errors with the plugin removed').toEqual([]);
    } finally {
      host.stop();
    }
    expect(hashTree(projectDir), 'a file of the project changed while the plugin was removed').toEqual(before);
    stage(t0, 'removed: project opens, study greyed, bytes unchanged');

    // The folder back: the study opens as it was.
    await page.goto('about:blank');
    ({ host } = await startEngineLessHost('airfoil-rm3', { projects, envs }));
    try {
      await openProject(page, host.base, PROJECT);
      await page.locator(`#ws-start-host [data-start-header="${START}"] > button`).click();
      await page.locator(`[data-start-study="${sid}"]`).click();
      await expect(overlay(page)).toBeVisible({ timeout: 30_000 });
      await expect(frame(page).locator('[data-af="naca"]')).toHaveValue('0012', { timeout: 60_000 });
      await expect(frame(page).locator('#af-engine')).toHaveValue('xfoil');
      await expect(frame(page).locator('.af-inputs')).toContainText('NACA 0012 · thickness 12.00 %');
    } finally {
      host.stop();
    }
    stage(t0, 'restored: the study reopens');
  } finally {
    rmSync(keep, { recursive: true, force: true });
  }
});
