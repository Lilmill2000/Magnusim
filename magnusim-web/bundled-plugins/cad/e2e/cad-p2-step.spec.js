// P2 exit gate (proposal §7 "P2: STEP editing slice", adjusted by docs/p2p3-plan.md
// §5.1 and Daniel's decisions): STEP files edited in the Part workspace as a user
// meets them, in the real host frame with the real kernel. One test per exit
// bullet; each asserts what the user sees (panel and tree text, chips, the Mass
// properties readouts, the download's bytes, the core page's own geometry).
//
//   1. flange.step (Import STEP, the browser's file picker) -> the panel says
//      "0 problems", the tree "Imported 1 (flange.step)", the body keeps the
//      STEP's name; 96,858.4 mm³; a drop imports box20.step too.
//   2. Select the flange's 4 hole faces, Delete -> Delete faces 1: the face count
//      drops by 4 (Mass properties 10 -> 6) and the volume grows by 4·pi·r²·t
//      (r 5, t 10; within 0.1%).
//   3. Press-pull the top face +10 mm -> the Size chip grows by 10 mm in Z.
//   4. Split by the Right plane -> 2 bodies ("flange", "flange (2)") of half the
//      volume each; renaming the second keeps its name.
//   5. Daniel's flow: Vortex (CAD_E2E_VORTEX_STEP) inside an Enclosure, Fixed
//      100 mm, Combine Cut (enclosure minus Vortex) = the fluid domain, 213,286,252.06
//      mm³ (native OCCT 7.9.3, 1e-6), 22 faces, valid; Keep tools keeps Vortex.
//      Export STEP (AP214) downloads it; the core's "+ Add geometry" takes the
//      file and loads 22 faces; natively (the app's Python, OCP 7.9.3) it is the
//      same volume.
//   6. Combine Join and Intersect on imported and modelled bodies (native
//      values), and Cut with two targets and one tool (analytic).
//   7. Measure: two parallel faces of a 20 mm block "20 mm"; a hole's radius "5 mm".
//   8. Reopen -> the same face names; no import_step or heal reaches the kernel
//      (no re-heal), and the panel says the shapes were loaded from the stored BREP.
//   9. A 600 MB STEP -> "This STEP is 600 MB. Parts can store files up to 512 MB."
//      and nothing uploads (the size rule: only files above 512 MB are refused).
//  10. A surface-only STEP -> "6 faces not in a solid", the volume chip says it is
//      a surface body (it read "8000 mm³" before), Heal all with knitting -> one
//      8,000 mm³ solid.
//  11. Contention: while the Vortex imports and autosaves, a core run writes its
//      run sidecar (POST /api/run/update -> runs.upsert) and the project tree is
//      read: no timeouts, no failures, tree p95 < max(3 x idle p95, 200 ms).
// Daniel's STEP files are read where they are (never copied), and only when
// CAD_E2E_VORTEX_STEP names the Vortex part: a test that needs it is skipped and says
// why without it, and fails with the path when the variable names no file. Numbers come from
// fixtures/kernel/reference.json (native OCP 7.9.3) or are analytic.
// window.__CAD__ is used only to project model points to screen pixels, to read
// face names (bullet 8) and the kernel's face geometry for where to click, and
// (helpers.ts addSolid) to set modelled blocks up as sketches and extrudes: there
// is no Box since decision 2026-10-01 (the Vortex fluid box is the Enclosure, made
// in its panel).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { appPythonMissing, findAppPython } from '../scripts/app-python.mjs';
import { addSolid, baseUrl, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame, runCommand, soloVolume, chipVolumes } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures', 'kernel');
const FLANGE = join(FIXTURES, 'flange.step');
const BOX20 = join(FIXTURES, 'box20.step');
const BOX20_FACES = join(FIXTURES, 'box20-faces.step');
const REF = JSON.parse(readFileSync(join(FIXTURES, 'reference.json'), 'utf8'));
const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';
// The app's Python (cadquery-ocp 7.9.3) for the native check, run inline (the plugin holds no .py but plugin.py):
// scripts/app-python.mjs, MAGNUSIM_PYTHON, the app's venv, or a python on PATH with the backend (CI).
const FOUND_PYTHON = findAppPython();
const PYTHON = FOUND_PYTHON.python ?? '';
const SHOTS = process.env.CAD_E2E_SHOTS || '';

// ---------------------------------------------------------------- helpers

const tb = (frame) => frame.locator('[data-cad-toolbar]');
const panel = (frame) => frame.locator('[data-cad-panel]');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const featureRow = (frame, name) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${esc(name)}$`) }) });
const bodyRows = (frame) => frame.locator('[data-cad-tree] [data-body-row]');
const volumeChip = (frame) => frame.locator('[data-chip="volume"]');
const volumeValue = (frame) => soloVolume(frame);
const sizeChip = (frame) => frame.locator('[data-chip="size"]');
const expectSaved = (frame) => expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 30_000 });

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** A fresh project with a new Part open in its workspace, document ready. */
async function freshPart(page, request) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, row, projectId };
}

/** Import STEP from the toolbar: the browser's file picker gets `path`. */
async function importByPicker(page, frame, path) {
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(path);
}

/** Drop a file on the frame as the browser does (a DataTransfer with the file's bytes, or only a size). */
async function dropFile(page, name, bytes) {
  const b64 = Buffer.isBuffer(bytes) ? bytes.toString('base64') : null;
  const size = Buffer.isBuffer(bytes) ? bytes.byteLength : bytes.size;
  await workspaceFrame(page).evaluate(
    ({ name, b64, size }) => {
      const data = b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(0);
      const file = new File([data], name);
      // A size the frame cannot hold in memory here (600 MB): the size rule reads file.size first.
      if (!b64) Object.defineProperty(file, 'size', { value: size });
      const dt = new DataTransfer();
      dt.items.add(file);
      const fire = (type) => document.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire('dragenter');
      fire('dragover');
      fire('drop');
    },
    { name, b64, size },
  );
}

/** Wait for the import panel to finish (progress gone, diagnostics shown), then Done. Returns the diagnostics line. */
async function finishImport(page, frame, shotName = null) {
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="import"]')).toBeVisible();
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  const diag = await p.locator('[data-import-diagnostics]').textContent();
  if (shotName) await shot(page, shotName);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  return diag;
}

/** Evaluate in the frame (state reads only). */
const cad = (page, fn, arg) => workspaceFrame(page).evaluate(fn, arg);

/** Page coordinates of a model point (the viewport's own projection). */
async function at(page, p) {
  const s = await cad(page, (q) => window.__CAD__.services.viewport.get().handle.project(q), p);
  expect(s, `projection of ${p}`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box.x + s[0], box.y + s[1]];
}

async function clickModel(page, p, modifiers = []) {
  const [x, y] = await at(page, p);
  // page.mouse.click takes no modifiers: hold them on the keyboard (Ctrl+click adds to the selection).
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(x, y);
  for (const m of modifiers) await page.keyboard.up(m);
}

/** Waits until no view transition runs. */
async function still(page) {
  await expect.poll(() => cad(page, () => window.__CAD__.services.viewport.get().handle.state.get().animating)).toBe(false);
}

/** A point on the wall of each cylindrical face of the first body with holes, on the side the camera sees. */
async function holeWallPoints(page) {
  return cad(page, async () => {
    const s = window.__CAD__.services;
    let t = null;
    for (const b of s.doc.state.get().rebuild.bodies) {
      t = await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'exact', face_mass: true });
      if (t.result.faces.some((f) => f.type === 'cylinder')) break;
    }
    const cam = s.viewport.get().handle.camera();
    const view = [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1]];
    const n = Math.hypot(view[0], view[1]) || 1;
    return t.result.faces.filter((f) => f.type === 'cylinder').map((f) => [f.axis.origin[0] + (f.radius * view[0]) / n, f.axis.origin[1] + (f.radius * view[1]) / n, f.bbox[5] - 2]);
  });
}

/** Open the tree's Bodies folder (its rows are clicked to pick bodies). */
async function openBodies(frame) {
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
}

async function openMass(frame) {
  await runCommand(frame, 'inspect.mass');
  const p = panel(frame);
  await expect(p.locator('[data-tool-panel="inspect.mass"]')).toBeVisible();
  return p;
}

/** The volume chip's exact figure is `mm3` within `rel` (relative). */
async function expectVolume(frame, mm3, rel = 1e-6, timeout = 60_000) {
  await expect
    .poll(async () => {
      const v = Number(await volumeValue(frame).getAttribute('data-volume-mm3', { timeout: 1000 }).catch(() => NaN));
      return Math.abs(v / mm3 - 1) <= rel ? 'ok' : `${v} (want ${mm3} within ${rel})`;
    }, { timeout })
    .toBe('ok');
}

/** A readout as the chips format it: 6 significant digits, digit groups from 10,000 up, significant figures above a million when rounded. */
const readout = (n) => {
  const v = Number(n.toPrecision(6));
  if (Math.abs(v) < 10_000) return String(v);
  // 7 digits or more that 6 significant digits do not hold: significant figures ("1.30484 × 10⁸"; UX review).
  if (Math.abs(v) >= 1_000_000 && Math.abs(v - n) > 1e-9 * Math.abs(n)) {
    let e = Math.floor(Math.log10(Math.abs(n)));
    let m = Number((n / 10 ** e).toPrecision(6));
    if (Math.abs(m) >= 10) {
      m = Number((m / 10).toPrecision(6));
      e += 1;
    }
    return `${m} × 10${String(e).split('').map((c) => (c === '-' ? '⁻' : '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(c)])).join('')}`;
  }
  return v.toLocaleString('en-US', { maximumFractionDigits: 20 });
};

/** A block with this corner and size: a rectangle sketched on Top and extruded (helpers.ts addSolid). */
const addBlock = (page, origin, size) => addSolid(page, { at: origin, size });

/**
 * The Vortex fluid box as a user makes it: Enclosure from the toolbar, Padding
 * Fixed, 100 mm, Done (reference fluid_box: 504.8 x 504.8 x 1012.8 mm).
 */
async function addFluidEnclosure(frame) {
  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Enclosure 1');
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  const input = p.locator('.nui[data-field="distance"] input');
  await input.fill('100');
  await input.press('Enter');
  await expect(p.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveCount(0);
  await expect(p.locator('[data-enclosure-size]')).toHaveText(/^Size: 504\.8 mm × 504\.8 mm × 1012\.8 mm · /);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
}

/** Combine from the toolbar: the operation, then target and tool bodies clicked in the tree (by row index). */
async function combine(frame, op, targets, tools) {
  await runCommand(frame, 'modify.combine');
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="combine"]')).toBeVisible();
  await p.locator('[data-field="op"] select').selectOption(op);
  await openBodies(frame);
  // Picking a target moves on to the tools (as Fusion does): click the Targets list before each one.
  for (const i of targets) {
    await p.locator('[data-pick-list="targets"]').click();
    await expect(p.locator('[data-pick-field="targets"]')).toHaveAttribute('data-active', '1');
    await bodyRows(frame).nth(i).locator('.tree-row').first().click();
  }
  await expect(p.locator('[data-pick-field="targets"] [data-pick-row]')).toHaveCount(targets.length);
  await p.locator('[data-pick-list="tools"]').click();
  await expect(p.locator('[data-pick-field="tools"]')).toHaveAttribute('data-active', '1');
  for (const i of tools) await bodyRows(frame).nth(i).locator('.tree-row').first().click();
  await expect(p.locator('[data-pick-field="tools"] [data-pick-row]')).toHaveCount(tools.length);
  return p;
}

/** The native check: the STEP read by OCP 7.9.3 (the core venv), ShapeFix at 0.001 mm: volume, faces, solids. */
function nativeStep(path) {
  expect(PYTHON, appPythonMissing(FOUND_PYTHON)).not.toBe('');
  const code = [
    'import sys, json',
    'from OCP.STEPControl import STEPControl_Reader',
    'from OCP.IFSelect import IFSelect_RetDone',
    'from OCP.GProp import GProp_GProps',
    'from OCP.BRepGProp import BRepGProp',
    'from OCP.TopExp import TopExp',
    'from OCP.TopTools import TopTools_IndexedMapOfShape',
    'from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID',
    'from OCP.ShapeFix import ShapeFix_Shape',
    'r = STEPControl_Reader()',
    'assert r.ReadFile(sys.argv[1]) == IFSelect_RetDone',
    'r.TransferRoots()',
    's = r.OneShape()',
    'fx = ShapeFix_Shape(s); fx.SetPrecision(0.001); fx.SetMaxTolerance(0.001); fx.Perform(); s = fx.Shape()',
    'p = GProp_GProps(); BRepGProp.VolumeProperties_s(s, p)',
    'f = TopTools_IndexedMapOfShape(); TopExp.MapShapes_s(s, TopAbs_FACE, f)',
    'v = TopTools_IndexedMapOfShape(); TopExp.MapShapes_s(s, TopAbs_SOLID, v)',
    'print(json.dumps({"volume": p.Mass(), "faces": f.Extent(), "solids": v.Extent()}))',
  ].join('\n');
  const out = execFileSync(PYTHON, ['-c', code, path], { encoding: 'utf8', timeout: 180_000 });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

function vortexPath() {
  test.skip(!VORTEX, "needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step");
  expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP is set but there is no file at ${VORTEX}`).toBe(true);
  return VORTEX;
}

/** Every op the frame's kernel worker is asked for, from the first moment of every load. */
async function spyKernelOps(page) {
  await page.context().addInitScript(() => {
    window.__kernelOps = [];
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.type === 'call' && msg.op) window.__kernelOps.push(msg.op);
      return orig.call(this, msg, ...rest);
    };
  });
}

/**
 * The run's sidecar (run.json) as the server this run uses reads it back from disk (GET
 * /api/run/status assembles a study's runs from their run.json files). Asked of the server, not
 * read from a projects folder beside a prefs file, so a run pointed at a running server with
 * CAD_E2E_BASE_URL alone checks it too (review P2/P3 round 4: it failed without CAD_E2E_PREFS).
 */
async function runSidecar(request, projectId, simId, runId) {
  const r = await request.get(`${baseUrl()}/api/run/status?${new URLSearchParams({ project_id: projectId, simulation_id: simId, run_id: runId })}`);
  expect(r.ok(), await r.text()).toBe(true);
  const body = await r.json();
  const run = body.run && body.run.id === runId ? body.run : (body.runs || []).find((x) => x && x.id === runId);
  return run || null;
}

const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : NaN;
};

// ---------------------------------------------------------------- 1. import

test('cad:p2-step-import flange.step by the picker: "0 problems", "Imported 1 (flange.step)", the STEP body name; box20.step by a drop', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // Before any body: the editing commands say why.
  await expect(tb(frame).locator('[data-command="modify.press-pull"]')).toHaveAttribute('data-disabled-reason', 'Make or import a body first');
  // What the Faces column says in the very render the diagnostics first appear in (L3 review
  // polish 5: it read "…" until the rebuild had made the body).
  await cad(page, () => {
    window.__facesAtDiagnostics = null;
    const look = () => {
      if (window.__facesAtDiagnostics !== null || !document.querySelector('[data-import-diagnostics]')) return;
      window.__facesAtDiagnostics = [...document.querySelectorAll('[data-import-bodies] tbody tr')].map((tr) => tr.children[2]?.textContent ?? '');
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await importByPicker(page, frame, FLANGE);
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Imported 1 (flange.step)');
  // The bodies table: the STEP's own name, a solid.
  await expect(p.locator('[data-import-bodies] tbody tr')).toHaveCount(1, { timeout: 60_000 });
  await expect(p.locator('[data-import-bodies] tbody td').first()).toHaveText('flange');
  await expect(p.locator('[data-import-bodies] tbody td').nth(1)).toHaveText('Solid');
  expect(await finishImport(page, frame, 'p2-import-flange-panel')).toBe('0 problems');
  expect(await cad(page, () => window.__facesAtDiagnostics)).toEqual([REF.flange.import.faces.toLocaleString('en-US')]);
  await expect(featureRow(frame, 'Imported 1 (flange.step)')).toHaveAttribute('data-state', 'ok');
  await expect(frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  await openBodies(frame);
  await expect(bodyRows(frame).locator('.cad-body-name')).toHaveText(['flange']);
  await expect(volumeChip(frame)).toHaveText(`Volume${readout(REF.flange.import.volume)} mm³`);
  await expectVolume(frame, REF.flange.import.volume);
  await expect(sizeChip(frame)).toHaveText('Size100 mm × 100 mm × 10 mm');
  // A drop imports too (the drop hint is the frame's own).
  await dropFile(page, 'box20.step', readFileSync(BOX20));
  expect(await finishImport(page, frame)).toBe('0 problems');
  await expect(featureRow(frame, 'Imported 2 (box20.step)')).toHaveAttribute('data-state', 'ok');
  // Each body with its own volume, never added together (P4a).
  await expect(volumeChip(frame)).toHaveText(`Volumeflange: ${readout(REF.flange.import.volume)} mm³ · ${await bodyRows(frame).locator('.cad-body-name').nth(1).textContent()}: 8000 mm³`);
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 2. delete faces

test('cad:p2-step-delete-faces the 4 hole faces selected, Delete: 4 faces fewer and the volume grows by 4·pi·r²·t (0.1%)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  await still(page);
  let mass = await openMass(frame);
  await expect(mass.locator('[data-mass-value="faces"]')).toHaveText(`${REF.flange.import.faces}, ${REF.flange.import.edges}`);
  await mass.locator('[data-panel-done]').click();
  // Faces only (the selection filter): the far hole is small on screen, and its rim edge is near.
  await frame.locator('[data-vp-opens="filter"]').click();
  await frame.locator('[data-filter="face"]').click();
  await expect(frame.locator('[data-filter="face"]')).toHaveAttribute('aria-pressed', 'true');
  await frame.locator('[data-vp-opens="filter"]').click();
  // Select first: the four hole walls (click, then Ctrl+click), then Delete.
  const holes = await holeWallPoints(page);
  expect(holes).toHaveLength(4);
  for (let i = 0; i < holes.length; i++) {
    await clickModel(page, holes[i], i ? ['Control'] : []);
    await expect.poll(() => cad(page, () => window.__CAD__.services.selection.get().items.filter((x) => x.kind === 'face').length)).toBe(i + 1);
  }
  await page.keyboard.press('Delete');
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await expect(p.locator('[data-panel-title]')).toHaveText('Delete faces 1');
  await expect(p.locator('[data-pick-field="faces"] .cad-pick-label')).toHaveText('Faces to delete (4)');
  const grown = REF.flange.import.volume + 4 * Math.PI * REF.flange.r_hole ** 2 * REF.flange.t;
  await expectVolume(frame, grown, 1e-3);
  await expect(volumeChip(frame)).toHaveText(`Volume${readout(grown)} mm³`);
  await shot(page, 'p2-delete-faces');
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Delete faces 1')).toHaveAttribute('data-state', 'ok');
  mass = await openMass(frame);
  await expect(mass.locator('[data-mass-value="faces"]')).toHaveText(new RegExp(`^${REF.flange.import.faces - 4}, `));
  await mass.locator('[data-panel-done]').click();
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-step-delete-faces-picks the holes clicked one by one in the Delete faces panel keep their own numbers, never "Face 8, Face 8, Face 8"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  await still(page);
  // The holes' numbers on the flange as imported (what Measure says of them before any change).
  const numbers = await cad(page, async () => {
    const s = window.__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: false });
    return t.result.faces.filter((f) => f.type === 'cylinder').map((f) => f.i + 1);
  });
  expect(numbers).toHaveLength(4);
  const holes = await holeWallPoints(page);
  // Delete faces from the toolbar, then each hole clicked in the viewport. The live result heals
  // each one as it is picked, so the body's faces are numbered anew before the next click.
  await runCommand(frame, 'modify.delete-faces');
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  for (let i = 0; i < holes.length; i++) {
    await clickModel(page, holes[i]);
    await expect(p.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(i + 1, { timeout: 30_000 });
    await expect.poll(() => cad(page, () => window.__CAD__.services.doc.state.get().rebuild.bodies[0]?.faces ?? -1), { timeout: 30_000 }).toBe(REF.flange.import.faces - (i + 1));
    await still(page);
  }
  // Each row its own number, the one the flange had when the panel opened (L3 review polish 4).
  await expect(p.locator('[data-pick-field="faces"] .cad-pick-name')).toHaveText(numbers.map((n) => `Face ${n} of flange`));
  await shot(page, 'p2-delete-faces-picks');
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Delete faces 1')).toHaveAttribute('data-state', 'ok');
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 3. press-pull

test('cad:p2-step-press-pull the top face +10 mm: the Size chip grows by 10 mm in Z', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  await still(page);
  await expect(sizeChip(frame)).toHaveText('Size100 mm × 100 mm × 10 mm');
  // The top face (z = 10), then Q.
  await clickModel(page, [-40, -40, 10]);
  await page.keyboard.press('q');
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="press_pull"]')).toBeVisible();
  await expect(p.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
  const d = p.locator('.nui[data-field="distance"] input');
  await d.fill('10');
  await d.press('Enter');
  await expect(p.locator('[data-press-sense]')).toHaveText('Adds material: the faces move out of the body');
  await expect(sizeChip(frame)).toHaveText('Size100 mm × 100 mm × 20 mm', { timeout: 30_000 });
  // The prism keeps the holes: twice the plate.
  await expectVolume(frame, 2 * REF.flange.import.volume);
  await shot(page, 'p2-press-pull');
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
  // Undo puts the 10 mm back; redo the 20.
  await page.keyboard.press('Control+z');
  await expect(sizeChip(frame)).toHaveText('Size100 mm × 100 mm × 10 mm', { timeout: 30_000 });
  await page.keyboard.press('Control+y');
  await expect(sizeChip(frame)).toHaveText('Size100 mm × 100 mm × 20 mm', { timeout: 30_000 });
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 4. split

test('cad:p2-step-split by the Right plane: 2 bodies of half the volume each, named after the STEP body; a rename sticks', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  await runCommand(frame, 'modify.split');
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="split"]')).toBeVisible();
  await openBodies(frame);
  await bodyRows(frame).first().locator('.tree-row').first().click();
  await expect(p.locator('[data-pick-field="targets"] [data-pick-row]')).toHaveCount(1);
  await expect(p.locator('[data-split-pieces]')).toHaveText('2 bodies', { timeout: 30_000 });
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Split 1')).toHaveAttribute('data-state', 'ok');
  await expect(frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (2)');
  await expect(bodyRows(frame).locator('.cad-body-name')).toHaveText(['flange', 'flange (2)']);
  const half = REF.flange.import.volume / 2;
  for (let i = 0; i < 2; i++) {
    await bodyRows(frame).nth(i).locator('.tree-row').first().click();
    await expect(volumeChip(frame)).toHaveText(`Volume${i ? 'flange (2)' : 'flange'} · ${readout(half)} mm³`);
    await expectVolume(frame, half);
    await expect(sizeChip(frame)).toHaveText('Size50 mm × 100 mm × 10 mm');
  }
  await shot(page, 'p2-split');
  // Rename the second piece: the name is stored with the Part.
  await bodyRows(frame).nth(1).locator('[data-body-act="rename"]').click();
  const input = frame.locator('[data-cad-tree] input[aria-label="Body name"]');
  await input.fill('Flange half');
  await input.press('Enter');
  await expect(bodyRows(frame).locator('.cad-body-name')).toHaveText(['flange', 'Flange half']);
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 5. Vortex fluid domain, export, core re-import, native

test("cad:p2-step-vortex-fluid Daniel's flow: Enclosure minus Vortex = the fluid domain; Export STEP; the core's + Add geometry loads its 22 faces; natively the same volume", async ({ page, request }) => {
  test.setTimeout(600_000);
  const vortex = vortexPath();
  const { seen, frame, projectId } = await freshPart(page, request);
  await importByPicker(page, frame, vortex);
  expect(await finishImport(page, frame)).toBe('0 problems');
  await expect(featureRow(frame, `Imported 1 (${vortex.split(/[\\/]/).pop()})`)).toHaveAttribute('data-state', 'ok');
  await expectVolume(frame, REF.vortex.import.volume);
  // The enclosure around it, 100 mm of margin (reference fluid_box).
  await addFluidEnclosure(frame);
  await expect(featureRow(frame, 'Enclosure 1')).toHaveAttribute('data-state', 'ok');
  // Combine Cut: target the enclosure (tree row 2), tool Vortex (row 1).
  const p = await combine(frame, 'cut', [1], [0]);
  // An Enclosure's body as the target: Keep the tool bodies is on by default (SD review round 1):
  // Vortex stays beside the fluid domain.
  await expect(p.locator('[data-switch="keep-tools"] input')).toBeChecked();
  await expect(frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (2)', { timeout: 240_000 });
  await expect(bodyRows(frame).locator('.cad-body-name')).toHaveText([REF.vortex.import.name, 'Enclosure 1']);
  // Off: only the fluid domain.
  await p.locator('[data-switch="keep-tools"] .cad-switch-label').click();
  await expect(frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)', { timeout: 240_000 });
  await expectVolume(frame, REF.cut_fluid.volume, 1e-6, 240_000);
  // The enclosure was picked in the tree as the target, so the chip speaks for it.
  await expect(volumeChip(frame)).toHaveText(`VolumeEnclosure 1 · ${readout(REF.cut_fluid.volume)} mm³`);
  await expect(p.locator('[data-pick-error]')).toHaveCount(0);
  await shot(page, 'p2-vortex-fluid-domain-panel');
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  // The cavity in the fluid domain, seen through the section view (Front plane), the whole part framed.
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await still(page);
  await frame.locator('[data-vp-opens="section"]').click();
  await expect(frame.locator('[data-vp-opens="section"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await still(page);
  await shot(page, 'p2-vortex-fluid-domain-combine');
  await frame.locator('[data-vp-opens="section"]').click();
  await expect(frame.locator('[data-vp-opens="section"]')).toHaveAttribute('aria-pressed', 'false');
  const mass = await openMass(frame);
  await expect(mass.locator('[data-mass-value="faces"]')).toHaveText(new RegExp(`^${REF.cut_fluid.faces}, `));
  await mass.locator('[data-panel-done]').click();
  await runCommand(frame, 'inspect.check');
  await expect(panel(frame).locator('[data-check-summary]')).toHaveText('Enclosure 1 is valid', { timeout: 60_000 });
  await panel(frame).locator('[data-panel-done]').click();

  // Export STEP (AP214): the download.
  await runCommand(frame, 'file.export-step');
  const ex = panel(frame);
  await expect(ex.locator('[data-field="schema"] select')).toHaveValue('AP214');
  const dl = page.waitForEvent('download');
  await ex.locator('[data-export-run]').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('Part 1.step');
  const path = join(test.info().outputDir, 'Part 1.step');
  await download.saveAs(path);
  const text = readFileSync(path, 'utf8');
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text).toContain('AUTOMOTIVE_DESIGN');
  await expect(ex.locator('[data-export-done]')).toHaveText(/^Exported Part 1\.step · [\d.]+ (KB|MB) · 1 body$/);
  await ex.locator('[data-panel-done]').click();
  await expectSaved(frame);

  // Natively (OCP 7.9.3, the core's own kernel): the same solid and volume.
  const native = nativeStep(path);
  expect(native.solids).toBe(1);
  expect(native.faces).toBe(REF.step_roundtrip_cut.reimport_faces);
  expect(Math.abs(native.volume / REF.cut_fluid.volume - 1)).toBeLessThan(1e-6);

  // The core page: Back, then "+ Add geometry" with the downloaded file; its viewer loads 22 faces.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const preview = page.waitForResponse((r) => r.url().includes('/api/geometry/cad') && r.url().includes('part=preview') && r.status() === 200, { timeout: 180_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '+ Add geometry' }).first().click();
  await (await chooser).setFiles(path);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('#geometries-list .geo-item[data-geom-id]')).toHaveCount(1);
  await expect(page.locator('#left-tree')).toContainText('Part 1');
  const meta = await (await preview).json();
  expect(meta.n_solids).toBe(1);
  expect(meta.faces.length).toBe(REF.step_roundtrip_cut.reimport_faces);
  // The page's own call, asked again: the same geometry the viewer shows.
  const again = await (await request.get(`${baseUrl()}/api/geometry/cad?project_id=${encodeURIComponent(projectId)}&part=preview`)).json();
  expect(again.faces.length).toBe(REF.step_roundtrip_cut.reimport_faces);
  await shot(page, 'p2-vortex-fluid-core-geometry');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 6. Combine Join / Intersect / several targets

test('cad:p2-step-combine-join-intersect Join and Intersect of an imported body with a modelled one (native values); one undo step', async ({ page, request }) => {
  test.setTimeout(480_000);
  const vortex = vortexPath();
  const side = REF.fuse_box_side;
  const { seen, frame } = await freshPart(page, request);
  await importByPicker(page, frame, vortex);
  await finishImport(page, frame);
  await addBlock(page, side.box.origin, [side.box.dx, side.box.dy, side.box.dz]);
  // Join: Vortex (row 1) with the block on its side (row 2): one body.
  const p = await combine(frame, 'join', [0], [1]);
  await expectVolume(frame, side.volume, 1e-6, 240_000);
  await expect(frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  await shot(page, 'p2-combine-join');
  // The same Combine as Intersect: what the two have in common.
  await p.locator('[data-field="op"] select').selectOption('intersect');
  await expectVolume(frame, side.common_volume, 1e-6, 240_000);
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  // Undo the whole Combine session in one step: both bodies are back.
  await page.keyboard.press('Control+z');
  await expect(featureRow(frame, 'Combine 1')).toHaveCount(0);
  await expect(frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (2)', { timeout: 60_000 });
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-step-combine-targets Cut with two targets and one tool: each target loses the overlap (analytic), the tool goes', async ({ page, request }) => {
  // Two 20 mm blocks cut by one bar across both (each loses 10 x 10 x 20).
  const { seen, frame: f2 } = await freshPart(page, request);
  await addBlock(page, [0, 0, 0], [20, 20, 20]);
  await addBlock(page, [30, 0, 0], [20, 20, 20]);
  await addBlock(page, [10, 5, -5], [30, 10, 30]);
  const q = await combine(f2, 'cut', [0, 1], [2]);
  // Each target 8000 - 2000 (P4a: the chip lists each body on its own, never a total).
  await expect.poll(() => chipVolumes(f2).then((v) => v.map((x) => Math.round(x * 1e6) / 1e6)), { timeout: 60_000 }).toEqual([6000, 6000]);
  await expect(f2.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (2)');
  // The panel shows its picks as the selection: the two targets, each with its own volume.
  await expect(volumeChip(f2)).toHaveText(/^Volume.+: 6000 mm³ · .+: 6000 mm³$/);
  await expect(volumeChip(f2)).not.toContainText('12,000');
  await q.locator('[data-panel-done]').click();
  await expect(featureRow(f2, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  await expectSaved(f2);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 7. measure

test('cad:p2-step-measure two parallel faces of a 20 mm block are "20 mm" apart; a hole of radius 5 reads "5 mm"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addBlock(page, [100, 0, 0], [20, 20, 20]);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  await tb(frame).locator('[data-command="inspect.measure"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-tool-panel="inspect.measure"]')).toBeVisible();
  await page.keyboard.press('f');
  await still(page);
  await clickModel(page, [110, 10, 20]);
  await expect(p.locator('[data-pick-row]')).toHaveCount(1);
  // From below (view 6), the block's bottom face.
  await page.keyboard.press('6');
  await still(page);
  await clickModel(page, [110, 10, 0]);
  await expect(p.locator('[data-pick-row]')).toHaveCount(2);
  await expect(p.locator('[data-measure-value="distance"]')).toHaveText('20 mm', { timeout: 30_000 });
  await expect(p.locator('[data-measure-value="angle"]')).toHaveText('0°');
  await shot(page, 'p2-measure');
  // A third pick starts over: a hole wall of the flange, its radius.
  await page.keyboard.press('7');
  await still(page);
  const holes = await holeWallPoints(page);
  await clickModel(page, holes[0]);
  await expect(p.locator('[data-pick-row]')).toHaveCount(1);
  await expect(p.locator('[data-measure-value="a.radius"]')).toHaveText('5 mm', { timeout: 30_000 });
  await p.locator('[data-panel-done]').click();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 8. reopen

test('cad:p2-step-reopen Back and reopen: the same face names, the stored BREP read, no import_step and no heal (no re-heal)', async ({ page, request }) => {
  await spyKernelOps(page);
  const { seen, frame, row } = await freshPart(page, request);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  // An edit on top, so names flow through a feature too.
  await clickModel(page, [-40, -40, 10]);
  await page.keyboard.press('q');
  await expect(panel(frame).locator('[data-feature-panel="press_pull"]')).toBeVisible();
  await expect(sizeChip(frame)).toHaveText('Size100 mm × 100 mm × 20 mm', { timeout: 30_000 });
  await panel(frame).locator('[data-panel-done]').click();
  const names = () => cad(page, () => window.__CAD__.services.doc.state.get().rebuild.bodies.map((b) => b.names?.faces ?? null));
  const before = await names();
  expect(before[0]).not.toBeNull();
  expect(before[0].length).toBeGreaterThan(0);
  expect(await cad(page, () => window.__kernelOps)).toEqual(expect.arrayContaining(['import_step', 'heal', 'brep_write']));
  await expectSaved(frame);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const again = await openPart(page, row);
  await expect(featureRow(again, 'Imported 1 (flange.step)')).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect(featureRow(again, 'Press-pull 1')).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect(sizeChip(again)).toHaveText('Size100 mm × 100 mm × 20 mm');
  expect(await names()).toEqual(before);
  const ops = await cad(page, () => window.__kernelOps);
  expect(ops).toContain('brep_read');
  expect(ops).not.toContain('import_step');
  expect(ops).not.toContain('heal');
  // The import's panel: loaded from the stored healed shapes, no reading or healing step.
  await featureRow(again, 'Imported 1 (flange.step)').locator('> .tree-row').dblclick();
  const p = panel(again);
  await expect(p.locator('[data-import-output="brep"]')).toHaveText(/^Loaded from the stored healed shapes in (\d+ ms|\d+\.\d s)$/);
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  await expect(p.locator('[data-import-diagnostics]')).toHaveText('0 problems');
  await shot(page, 'p2-reopen-import-panel');
  await p.locator('[data-panel-done]').click();
  expect(await cad(page, () => window.__kernelOps)).not.toContain('heal');
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 9. size rule

test('cad:p2-step-size a 600 MB STEP is refused before anything uploads; the rule is 512 MB', async ({ page, request }) => {
  const { seen, frame, projectId } = await freshPart(page, request);
  const uploads = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().split('?')[0].endsWith('/api/plugin-files/uploads') && (r.postData() ?? '').includes('/imports/')) uploads.push(r.postData() ?? '');
  });
  await dropFile(page, 'huge.step', { size: 600 * 1024 * 1024 });
  await expect(page.locator('[data-ws-toast]').filter({ hasText: 'This STEP is 600 MB. Parts can store files up to 512 MB.' })).toBeVisible();
  await expect(panel(frame)).toHaveCount(0);
  await expect(frame.locator('[data-cad-tree] [data-feature-row]')).toHaveCount(0);
  expect(uploads).toEqual([]);
  const listed = await (await request.get(`${baseUrl()}/api/plugin-files/list?${new URLSearchParams({ project_id: projectId, plugin: 'cad', prefix: 'studies' })}`)).json();
  expect(listed.files.filter((f) => f.rel.includes('/imports/'))).toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 10. diagnostics, surface body, knit

test('cad:p2-step-knit a surface-only STEP: "6 faces not in a solid", the volume chip says "Surface body", Heal all knits one 8,000 mm³ solid', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  expect(existsSync(BOX20_FACES), `the fixture ${BOX20_FACES} is missing`).toBe(true);
  await importByPicker(page, frame, BOX20_FACES);
  const p = panel(frame);
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 60_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  await expect(p.locator('[data-import-loose]')).toHaveText('6 faces not in a solid');
  await expect(p.locator('[data-import-shells]')).toHaveText('1 surface body: knit the faces into solids with Heal all');
  await expect(p.locator('[data-import-bodies] tbody td').nth(1)).toHaveText('Surface');
  // An open shell has no volume (the chip read "8000 mm³" for six loose faces before).
  await expect(volumeChip(frame)).toHaveText('VolumeSurface body: no volume', { timeout: 30_000 });
  await expect(p.locator('[data-switch="knit"] input')).toBeChecked();
  await shot(page, 'p2-diagnostics-panel');
  await p.locator('[data-import-heal]').click();
  await expect(p.locator('[data-import-bodies] tbody td').nth(1)).toHaveText('Solid', { timeout: 60_000 });
  await expect(p.locator('[data-import-healed]')).toHaveText('Healed at 0.001 mm, knit');
  await expect(p.locator('[data-import-loose]')).toHaveCount(0);
  await expect(volumeChip(frame)).toHaveText('Volume8000 mm³', { timeout: 30_000 });
  await shot(page, 'p2-diagnostics-knit');
  await p.locator('[data-panel-done]').click();
  // Import and Heal all are one undo step.
  await page.keyboard.press('Control+z');
  await expect(featureRow(frame, 'Imported 1 (box20-faces.step)')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(featureRow(frame, 'Imported 1 (box20-faces.step)')).toHaveAttribute('data-state', 'ok');
  await expect(volumeChip(frame)).toHaveText('Volume8000 mm³', { timeout: 30_000 });
  await expectSaved(frame);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 11. contention with a core run

test('cad:p2-step-contention importing and autosaving while a core run writes its sidecar: no project.tree or runs.upsert timeouts', { tag: '@serial' }, async ({ page, request }) => {
  test.setTimeout(480_000);
  const vortex = vortexPath();
  const { seen, frame, projectId } = await freshPart(page, request);
  const base = baseUrl();
  // A core study with a run (its geometry through the core's own import route).
  const geo = await request.post(`${base}/api/geometry/import?${new URLSearchParams({ project_id: projectId, filename: 'box20.step' })}`, { headers: { 'content-type': 'application/octet-stream' }, data: readFileSync(BOX20) });
  expect(geo.ok(), await geo.text()).toBe(true);
  const sim = await (await request.post(`${base}/api/simulation`, { data: { project_id: projectId, analysis: 'incompressible_steady' } })).json();
  const simId = (sim.simulation || sim).id;
  expect(simId, JSON.stringify(sim)).toBeTruthy();
  const run = await (await request.post(`${base}/api/run/create`, { data: { project_id: projectId, simulation_id: simId } })).json();
  expect(run.ok, JSON.stringify(run)).toBe(true);
  const runId = run.run.id;

  // Load: a run sidecar write (POST /api/run/update -> runs.upsert) every 200 ms, and the tree read every 250 ms.
  const timed = async (fn) => {
    const t0 = performance.now();
    const r = await fn();
    return { ms: performance.now() - t0, status: r.status(), ok: r.ok() };
  };
  const treeUrl = `${base}/api/project/tree?project_id=${encodeURIComponent(projectId)}`;
  const loop = (every, fn) => {
    let stop = false;
    const out = [];
    const done = (async () => {
      while (!stop) {
        const t0 = performance.now();
        out.push(await fn().catch((e) => ({ ms: performance.now() - t0, status: 0, ok: false, error: String(e) })));
        const wait = every - (performance.now() - t0);
        if (wait > 0 && !stop) await new Promise((r) => setTimeout(r, wait));
      }
    })();
    return { out, stop: async () => ((stop = true), await done, out) };
  };
  let k = 0;
  const upsert = () => timed(() => request.post(`${base}/api/run/update`, { data: { project_id: projectId, simulation_id: simId, run_id: runId, current_view: { contention: ++k } }, timeout: 60_000 }));
  const tree = () => timed(() => request.get(treeUrl, { timeout: 60_000 }));

  // Idle: the tree alone for 5 s. Then the core alone: the run writing its sidecar while the tree is read, 8 s
  // (both are calls on the core's own worker lane, so they queue behind each other: CAD adds nothing there).
  const idle = loop(250, tree);
  await page.waitForTimeout(5000);
  const idleTree = await idle.stop();
  const coreUps = loop(200, upsert);
  const coreReads = loop(250, tree);
  await page.waitForTimeout(8000);
  const coreUpOut = await coreUps.stop();
  const coreTree = await coreReads.stop();
  // Loaded (at least 15 s): the run writes and the tree reads while the Vortex imports (upload, read,
  // heal, BREP write, store), the fluid box is cut from it (kernel work, saves), and renames autosave.
  const ups = loop(200, upsert);
  const reads = loop(250, tree);
  const t0 = performance.now();
  const vortexRow = `Imported 1 (${vortex.split(/[\\/]/).pop()})`;
  await importByPicker(page, frame, vortex);
  await finishImport(page, frame);
  await addFluidEnclosure(frame);
  const cp = await combine(frame, 'cut', [1], [0]);
  // The fluid alone (Keep the tool bodies comes on for an Enclosure target: off here).
  await expect(cp.locator('[data-switch="keep-tools"] input')).toBeChecked();
  await cp.locator('[data-switch="keep-tools"] .cad-switch-label').click();
  await expectVolume(frame, REF.cut_fluid.volume, 1e-6, 240_000);
  await cp.locator('[data-panel-done]').click();
  let renames = 0;
  let current = vortexRow;
  while (performance.now() - t0 < 15_000 || renames < 3) {
    const name = `Vortex ${++renames}`;
    await featureRow(frame, current).locator('> .tree-row').click();
    await page.keyboard.press('F2');
    const input = frame.locator('[data-cad-tree] input[aria-label="Feature name"]');
    await input.fill(name);
    await input.press('Enter');
    await expect(featureRow(frame, name)).toHaveCount(1);
    current = name;
  }
  await expectSaved(frame);
  const loadedMs = performance.now() - t0;
  const upOut = await ups.stop();
  const treeOut = await reads.stop();
  const fails = [...coreUpOut, ...coreTree, ...upOut, ...treeOut].filter((r) => !r.ok);
  const ms = (xs) => xs.map((r) => r.ms);
  const idleP95 = p95(ms(idleTree));
  const coreP95 = p95(ms(coreTree));
  const loadP95 = p95(ms(treeOut));
  const coreUpP95 = p95(ms(coreUpOut));
  const upP95 = p95(ms(upOut));
  const line = `contention: project.tree p95 idle ${idleP95.toFixed(1)} ms (n=${idleTree.length}); with the run writing ${coreP95.toFixed(1)} ms (n=${coreTree.length}, runs.upsert p95 ${coreUpP95.toFixed(1)} ms n=${coreUpOut.length}); with the run writing and CAD importing and autosaving for ${Math.round(loadedMs)} ms ${loadP95.toFixed(1)} ms max ${Math.max(...ms(treeOut)).toFixed(1)} ms (n=${treeOut.length}, runs.upsert p95 ${upP95.toFixed(1)} max ${Math.max(...ms(upOut)).toFixed(1)} ms n=${upOut.length}); failures ${fails.length}`;
  console.log(`[cad-p2-step] ${line}`);
  test.info().annotations.push({ type: 'contention', description: line });
  expect(fails, JSON.stringify(fails.slice(0, 5))).toEqual([]);
  expect(upOut.length).toBeGreaterThan(40);
  expect(treeOut.length).toBeGreaterThan(40);
  // No call came near the worker's 30 s RPC timeout; the tree stays quick.
  expect(Math.max(...ms(upOut), ...ms(treeOut))).toBeLessThan(5000);
  // What CAD adds on top of the core's own load: the tree's p95 stays within 3x (P0 gate 10's measure).
  expect(loadP95, line).toBeLessThan(3 * coreP95);
  // The path under test ran: the run's sidecar (run.json, written by runs.upsert) holds the last write.
  expect((await runSidecar(request, projectId, simId, runId))?.current_view, 'the run sidecar').toEqual({ contention: k });
  await expect(featureRow(frame, current)).toHaveAttribute('data-state', 'ok');
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  expect(seen.errors, 'console errors').toEqual([]);
});
