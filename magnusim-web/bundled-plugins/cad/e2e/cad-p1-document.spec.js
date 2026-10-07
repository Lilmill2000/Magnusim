// P1 exit gate (proposal §7 "P1: Workspace and document"): the Part workspace
// and its document as a user meets them, in the real host with the real kernel.
// Every exit bullet is a test below; each asserts what the user sees (tree text,
// chips, computed styles, viewport pixels, the host's own rows and dialogs).
// The host has API 1.2 (42e38c6): an optional bundled plugin can ship on or off
// (G11; CAD ships on since D33), the model is kept with ws.files and etags (G1),
// and unsaved work makes every way out ask (G7).
//
//   1. CAD is On in Settings > Plugins on a fresh install (no ship-off hint, with
//      Disable), its workspace files are served, and an existing project offers it
//      in the header ("CAD"; STUDIES stays hidden until the project has a Part).
//      Disable there -> the header button goes and the files are not served;
//      Enable -> back. "+ New Part" opens the workspace; the tree shows Top /
//      Front / Right plane and "No features yet".
//   2. A 20 x 20 rectangle sketched on Top (Sketch, R, the size typed), Extrude ->
//      flyout "Extrude 1" -> 20 mm, Done -> "Bodies (1)" and the volume chip (8000
//      mm³); a circle extruded with Cut -> volume = block - the overlap (analytic).
//      (Decision 2026-10-01: no one-click Box or Cylinder; solids come from sketches.)
//   3. Ctrl+Z removes the last feature, Ctrl+Y restores it.
//   4. Suppress greys the row and hides the body; dragging the rollback bar above
//      it dims it.
//   5. Back and reopen restores the tree.
//   6. A rename in the header crumb, then an edit: no conflict. An edit from a
//      second tab is refused on its etag (the host answers 409 "changed"):
//      "Changed in another tab · Reload", and Reload adopts it.
//   7. Parameters: width = 40 mm, an Extrude's distance is "width", changing width updates the volume.
//   8. Plugin off -> the Part row is greyed with its reason; Settings' Enable on
//      CAD's row turns it on again and the Part opens as it was.
//   9. A broken CAD manifest -> the core still loads, and the CAD rows show why:
//      Settings lists "Magnusim CAD v0.0.0 · bundled", "Failed to load", with the
//      TOML parser's line and column; the Part says "Requires the Magnusim CAD
//      plugin." (manifest.toml is broken in place for this one test and put back
//      after; e2e/manifest-guard.mjs restores it at the start of any later run).
//  10. Visual parity: computed styles of tree rows, the flyout panel and Done
//      equal the core's LeftTree / PanelChrome values, read from the core page in
//      the same run. With CAD_E2E_SHOTS set, screenshot pairs (core beside CAD).
// Review round 1 (bugs found by clicking through; each one is a test here):
//  11. Undo, redo, undo within 1.5 s ends on "Saved" (it stayed on "Saving…").
//  12. Leaving while a save is on its way (its commit held, so the page is dirty
//      for as long as the test needs): since L3 (host API 1.6) the Part's exit
//      hook saves first, so the header's Back, Home and the browser's Back wait for
//      the save ("Saving Part 1" in the header) instead of asking "Leave without
//      saving?"; Cancel keeps the page and the edit; once saved, Back leaves and
//      the edit is there; a save dropped on the way out is written again.
//  13. Keys work as soon as the Part opens and again after the app's Settings,
//      with no click in the frame; the dock says "Click here to use keyboard
//      shortcuts" only while the frame has no keyboard focus (after a click on
//      the host's header).
//  14. 64-character feature and body names end in an ellipsis inside the card;
//      the row's buttons stay clear of them.
// Review round 2:
//  15. The mouse's side Back button over the part with a save on its way waits
//      for it too (L3); ten tree-twisty clicks never make a suppress wait. F5 with a save on
//      its way: cad-p1-leave-f5.spec.js (the browser's own prompt).
//  16. Settings > Plugins describes only what CAD has (since SD: sketches, extrude,
//      booleans, the enclosure, STEP; no boxes and cylinders; nothing of later phases).
// Review round 3:
//  17. Operation (New body / Join / Cut / Intersect) is offered only when a body
//      is made before the feature in history; Extrude 2 joins Extrude 1.
//  18. A reload after a save shows the saved model, read with ws.files.
// P1.5 review round 1:
//  19. With a save on its way, a link typed to another project waits for it (L3)
//      and Settings > Plugins > Disable (no exit hook) asks "Turn off Magnusim CAD?"
//      with CAD's words; Cancel keeps the edit and CAD on.
//  20. A Cut flush against a face and a Join along an edge say what is missing
//      (touching is not overlapping; an edge is not a shared face).
// window.__CAD__ is used only to project model points to screen pixels and to
// read where the camera looks.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSketch, addSolid, answerLeave, baseUrl, cadPluginRow, cancelLeave, drawRectangle, ensureCadOn, expectLeaveWaitsForSave, headerTakesKeyboard, historyState, holdCommits, newPartFromTree, newProject, openPart, openProject, partOpened, resetCadToDefault, watchPage, workspaceFrame, runCommand, soloVolume } from './helpers';
import { breakManifest } from './manifest-guard.mjs';
import { PNG } from './png';

/** The plugin's version as its manifest states it (read before any test breaks the manifest). */
const CAD_VERSION = /^version = "([^"]+)"/m.exec(readFileSync(fileURLToPath(new URL('../manifest.toml', import.meta.url)), 'utf8'))[1];

const SAMPLE_PROJECT = 'sample-project-steady-state-e2e';

// ---------------------------------------------------------------- helpers

/** CAD's row in Settings > Plugins (opens the wizard at its Plugins step). */
async function openSettingsPlugins(page) {
  await expect(page.locator('#wb-prefs')).toHaveText('Settings');
  await page.locator('#wb-prefs').click();
  const wizard = page.locator('#setup-wizard');
  await expect(wizard).toBeVisible();
  await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
  const step = wizard.locator('.wiz-pane[data-wiz-step="5"]');
  await expect(step).toBeVisible();
  return step;
}

async function closeSettings(page) {
  await page.locator('#wiz-skip').click();
  await expect(page.locator('#setup-wizard')).toBeHidden();
}

/** A fresh project with a new Part open in its workspace, document ready. */
async function freshPart(page, request, title = 'Part 1') {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, title);
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, row, projectId };
}

const historyLabels = (frame) => frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl');
const featureRow = (frame, name) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${name}$`) }) });
const bodiesLabel = (frame) => frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl');
const volumeValue = (frame) => soloVolume(frame);

/** A readout as the chip formats it: 6 significant digits, digit groups from 10,000 up, significant figures above a million when rounded. */
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

/** The volume chip shows `mm3` (to 6 significant digits, as the chip formats it) and carries it exactly. */
async function expectVolume(frame, mm3) {
  const text = `${readout(mm3)} mm³`;
  await expect(volumeValue(frame)).toHaveText(text);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText(`Volume${text}`);
  const shown = Number(await volumeValue(frame).getAttribute('data-volume-mm3'));
  expect(Math.abs(shown - mm3) / mm3, `volume ${shown} vs ${mm3}`).toBeLessThan(1e-9);
}

async function expectSaved(frame) {
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });
}

/**
 * Back the way a person does it: the pointer travels from where it is (inside
 * the frame) to the host's Back button and clicks it, the button held down for
 * 80 ms as a finger does (the host acts on the release). `asks`: the app asks first
 * (the question stays open for the caller). `waits`: a save is on its way, and the exit
 * (host API 1.6: the Part's exit hook saves first) waits for it, saying so in the header.
 */
async function backByPointer(page, { asks = false, waits = false } = {}) {
  const back = await page.locator('#workspace-overlay [data-ws-back]').boundingBox();
  const x = back.x + back.width / 2;
  const y = back.y + back.height / 2;
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.click(x, y, { delay: 80 });
  if (asks) await expect(page.locator('#modal-confirm')).toBeVisible();
  else if (waits) await expectLeaveWaitsForSave(page);
  else await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 60_000 });
}

/** The host header's unsaved-work mark, and what it says (null when the page is clean). */
async function headerDirty(page) {
  const shell = page.locator('#workspace-overlay .ws-shell');
  if ((await shell.getAttribute('data-workspace-dirty')) !== '1') return null;
  return page.locator('#workspace-overlay [data-ws-dirty]').getAttribute('title');
}

/** The saved model as the host stores it (GET /api/plugin-files/read): the bytes ws.files wrote. */
async function storedModel(request, projectId, studyId) {
  const q = new URLSearchParams({ project_id: projectId, plugin: 'cad', rel: `studies/${studyId}/model.json` });
  const r = await request.get(`${baseUrl()}/api/plugin-files/read?${q}`);
  expect(r.ok(), await r.text()).toBe(true);
  return { json: JSON.parse(await r.text()), etag: r.headers().etag ?? null };
}

const studyIdOf = (page) => {
  const m = /\/ws\/cad\/part\/([^/?#]+)/.exec(decodeURIComponent(page.url()));
  if (!m) throw new Error(`not a Part workspace address: ${page.url()}`);
  return m[1];
};

/**
 * A 20 mm cube as the app makes solids (decision 2026-10-01): Sketch N (a 20 x 20
 * rectangle on Top) and Extrude N, 20 mm (two edits; helpers.ts addSolid).
 */
const addBlock = (page) => addSolid(page);

/** A 64-character name (the rename fields take at most 64). */
const LONG = (head) => `${head} ${'that goes on and on to see what the tree row does with it ok'}`.slice(0, 64);

/** Type a value into a panel field and commit it (Enter), as a user does. */
async function setField(panel, field, value) {
  const input = panel.locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel.locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

/** Right-click a history row and pick a menu item. */
async function rowMenu(frame, row, item) {
  await row.locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await menu.locator(`[data-menu-item="${item}"]`).click();
  await expect(menu).toHaveCount(0);
}

/**
 * The viewport pixel (r,g,b) at a model point: the viewport's own projection
 * plus the frame's offset, once no view transition runs. `bodies` is how many
 * bodies the viewport must be drawing first.
 */
async function pixelAt(page, p, bodies) {
  const info = await workspaceFrame(page).evaluate((pt) => {
    const h = window.__CAD__.services.viewport.get().handle;
    if (!h) return null;
    const s = h.state.get();
    return { xy: h.project(pt), bodies: s.bodies, animating: s.animating, w: window.innerWidth, hgt: window.innerHeight };
  }, p);
  if (!info || !info.xy || info.animating || info.bodies !== bodies) return `not ready ${JSON.stringify(info)}`;
  const [x, y] = info.xy;
  if (x < 2 || y < 2 || x > info.w - 3 || y > info.hgt - 3) return `off screen ${JSON.stringify(info)}`;
  const box = await page.locator('#workspace-frame').boundingBox();
  const png = await page.screenshot({ clip: { x: box.x + x - 2, y: box.y + y - 2, width: 5, height: 5 } });
  return PNG.center(png).join(',');
}

const rgb = (s) => s.split(',').map(Number);

function shotsDir() {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A full-page screenshot into CAD_E2E_SHOTS (when set). */
async function shot(page, name) {
  const dir = shotsDir();
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Computed style values of the first match. */
const styleOf = (loc, props) =>
  loc.first().evaluate((el, names) => {
    const s = getComputedStyle(el);
    return Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n)]));
  }, props);

const heightOf = async (loc) => Math.round((await loc.first().boundingBox()).height);

test.beforeEach(async ({ request }, info) => {
  // The first test meets CAD as a fresh install has it (on, D33), and turns it off and on in Settings (bullet 1).
  if (!/p1-document-open/.test(info.title)) await ensureCadOn(request);
});

// ---------------------------------------------------------------- 1-5

test('cad:p1-document-open CAD ships on; Disable and Enable in Settings; "+ New Part" opens the workspace; a sketch extruded, a Cut, undo/redo, suppress, rollback, reopen', { tag: '@serial' }, async ({ page, request }) => {
  const seen = await watchPage(page);
  // 1. A fresh install: CAD's choice is not remembered on this PC, so its manifest's default holds: on (D33).
  await resetCadToDefault(request);
  // What the user sees first (P1.5 review round 1: these come before the API's own checks).
  // An existing project offers CAD in the header ("CAD", its menu makes a Part); with no Part
  // yet, STUDIES stays hidden (the kind opens from the header button) and so does the
  // Workspaces menu (CAD's kind is a header button).
  await openProject(page, SAMPLE_PROJECT);
  await expect(page.locator('#left-tree')).toBeVisible();
  const cadHeader = page.locator('#ws-start-host [data-start-header="cad:part"] > button');
  await expect(cadHeader).toHaveText('CAD');
  await expect(page.locator('#plugin-studies-section')).toBeHidden();
  await expect(page.locator('#btn-workspaces')).toHaveCount(0);
  // Settings > Plugins: CAD is On, with no ship-off hint, and offers Disable.
  const step = await openSettingsPlugins(page);
  const cadRow = step.locator('[data-plugin-key="cad"]');
  await expect(cadRow.locator('.wiz-pref-copy > strong')).toHaveText(`Magnusim CAD v${CAD_VERSION} · bundled`);
  await expect(cadRow.locator('.wiz-plugin-status')).toHaveText('On');
  await expect(cadRow.locator('[data-plugin-optional-hint]')).toHaveCount(0);
  await expect(cadRow.locator('[data-plugin-toggle="cad"]')).toHaveText('Disable');
  await expect(cadRow).toHaveAttribute('data-plugin-status', 'enabled');
  await expect(cadRow).not.toHaveAttribute('data-plugin-default-off', /.*/);
  await shot(page, 'p15-settings-cad-on');
  // The same from the API: on by its manifest alone, and its workspace files are served.
  const fresh = await cadPluginRow(request);
  expect(fresh).toMatchObject({ status: 'enabled' });
  expect(fresh.default_enabled).not.toBe(false);
  expect((await request.get(`${baseUrl()}/plugins/cad/workspace/index.html`)).status()).toBe(200);
  // Disable: off at once, remembered; its files are not served, and the header button goes.
  await cadRow.locator('[data-plugin-toggle="cad"]').click();
  await expect(cadRow).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 });
  await expect(cadRow.locator('.wiz-plugin-status')).toHaveText('Off');
  await expect(cadRow.locator('[data-plugin-toggle="cad"]')).toHaveText('Enable');
  await expect(cadRow.locator('[data-plugin-optional-hint]')).toHaveCount(0);
  expect(await cadPluginRow(request)).toMatchObject({ status: 'disabled' });
  expect((await request.get(`${baseUrl()}/plugins/cad/workspace/index.html`)).status(), 'workspace files are not served while off').toBe(404);
  await expect(cadHeader).toHaveCount(0, { timeout: 30_000 });
  // Enable: on again at once.
  await cadRow.locator('[data-plugin-toggle="cad"]').click();
  await expect(cadRow).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 30_000 });
  await expect(cadRow.locator('.wiz-plugin-status')).toHaveText('On');
  await expect(cadRow.locator('[data-plugin-toggle="cad"]')).toHaveText('Disable');
  await page.locator('#wiz-next').click();
  await expect(page.locator('#setup-wizard')).toBeHidden();
  // The same project offers Parts again.
  await expect(cadHeader).toHaveText('CAD', { timeout: 30_000 });
  await shot(page, 'p15-header-cad');
  expect(await cadPluginRow(request)).toMatchObject({ status: 'enabled', files: { max_file_bytes: 512 * 1024 * 1024, max_total_bytes: 4096 * 1024 * 1024 } });
  expect((await request.get(`${baseUrl()}/plugins/cad/workspace/index.html`)).status()).toBe(200);

  // A project of its own for the Part (the sample project stays as it is for the parity test).
  const projectId = await newProject(request);
  await openProject(page, projectId);

  // STUDIES "+ New Part" -> the host's name prompt ("Part 1") -> the workspace opens by itself.
  const partRow = await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toHaveText(/Magnusim CAD\s*›\s*Part 1/);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const tree = frame.locator('[data-cad-tree]');
  await expect(tree.locator('.geo-head')).toHaveText(['PART', 'HISTORY']);
  await expect(tree.locator('[data-tree-node^="origin:"] > .tree-row .tl')).toHaveText(['Top plane', 'Front plane', 'Right plane', 'X axis', 'Y axis', 'Z axis']);
  await expect(tree.locator('[data-tree-empty="history"]')).toHaveText('No features yet');
  await expect(bodiesLabel(frame)).toHaveText('Bodies (0)');
  await expect(frame.locator('[data-chip="volume"]')).toHaveCount(0);

  // 2. No one-click solids (decision 2026-10-01): a 20 x 20 rectangle sketched on Top, then
  // Extrude -> flyout "Extrude 1" beside the tree -> 20 mm, Done -> "Bodies (1)", volume 20 x 20 x 20.
  const tb = frame.locator('[data-cad-toolbar]');
  await expect(tb.locator('[data-command="solid.box"], [data-command="solid.cylinder"]')).toHaveCount(0);
  await drawRectangle(page, frame, 20, 20);
  await expect(historyLabels(frame)).toHaveText(['Sketch 1']);
  await tb.locator('[data-command="solid.extrude"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  const flyout = await frame.locator('[data-cad-flyout]').boundingBox();
  const card = await tree.boundingBox();
  expect(flyout.x).toBeGreaterThan(card.x + card.width);
  await setField(panel, 'distance', '20');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await expect(historyLabels(frame)).toHaveText(['Sketch 1', 'Extrude 1']);
  await expect(bodiesLabel(frame)).toHaveText('Bodies (1)');
  await expectVolume(frame, 8000);

  // A cut from the block: a Ø8 circle centred at (10, 10), extruded from z = -5, 30 long, with Cut.
  // It passes through the block's full 20 mm height: overlap = pi r^2 h = pi * 16 * 20.
  await addSolid(page, { circle: true, at: [10, 10, -5], size: [8, 30], op: 'cut' });
  const cut = 8000 - Math.PI * 16 * 20;
  await expect(historyLabels(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  await expect(bodiesLabel(frame)).toHaveText('Bodies (1)');
  await expectVolume(frame, cut);
  await expect(featureRow(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok');
  await shot(page, 'p1-doc-cut');

  // 3. Ctrl+Z removes the last feature, Ctrl+Y restores it.
  await tree.locator('[data-part-name] > .tree-row').click();
  await page.keyboard.press('Control+z');
  await expect(historyLabels(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2']);
  await expectVolume(frame, 8000);
  await page.keyboard.press('Control+y');
  await expect(historyLabels(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  await expectVolume(frame, cut);
  await expectSaved(frame);

  // 4. Suppress Extrude 1: its row greys and strikes through, and the body is gone from the part and the viewport.
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  await tb.locator('[data-command="view.fit"]').click();
  const onBox = [10, 0, 10]; // the middle of the block's front face (y = 0), clear of the cut
  await expect.poll(() => pixelAt(page, onBox, 1), { timeout: 20_000 }).toMatch(/^\d+,\d+,\d+$/);
  const before = rgb(await pixelAt(page, onBox, 1));
  expect(before[0], `body pixel ${before}`).toBeLessThan(180);
  const box1 = featureRow(frame, 'Extrude 1');
  await rowMenu(frame, box1, 'suppress');
  await expect(box1).toHaveAttribute('data-suppressed', '1');
  await expect(box1.locator('> .tree-row .tl')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(box1.locator('> .tree-row .tl')).toHaveCSS('color', 'rgb(152, 162, 179)');
  await expect(box1.locator('.tree-sub')).toHaveText('Suppressed');
  await expect(bodiesLabel(frame)).toHaveText('Bodies (0)');
  await expect(frame.locator('[data-chip="volume"]')).toHaveCount(0);
  // The cut after it has nothing left to cut, and says so.
  const cyl = featureRow(frame, 'Extrude 2');
  await expect(cyl).toHaveAttribute('data-state', 'error');
  await expect(cyl.locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', /What's wrong: Nothing to cut/);
  // No body drawn there now: only the background, or the translucent origin planes an empty part shows.
  await expect.poll(async () => {
    const px = await pixelAt(page, onBox, 0);
    return /^\d/.test(px) && Math.min(...rgb(px)) >= 195 ? 'no body' : px;
  }, { timeout: 20_000 }).toBe('no body');
  await shot(page, 'p1-doc-suppressed');

  // Dragging the rollback bar above it dims it (and every row below the bar).
  const bar = tree.locator('[data-rollback-bar]');
  const b = await bar.boundingBox();
  const first = await featureRow(frame, 'Sketch 1').locator('> .tree-row').boundingBox();
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 30, first.y + 4, { steps: 6 });
  await page.mouse.up();
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(4);
  await expect(box1.locator('> .tree-row')).toHaveCSS('opacity', '0.55');
  await expect(cyl.locator('> .tree-row')).toHaveCSS('opacity', '0.55');
  await shot(page, 'p1-doc-rolled-back');
  // Back to the end (keyboard on the bar), then Unsuppress: the body and the cut come back.
  await bar.focus();
  await page.keyboard.press('End');
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(0);
  await expect(box1.locator('> .tree-row')).toHaveCSS('opacity', '1');
  await rowMenu(frame, box1, 'suppress');
  await expect(box1).not.toHaveAttribute('data-suppressed', '1');
  await expect(cyl).toHaveAttribute('data-state', 'ok');
  await expect(bodiesLabel(frame)).toHaveText('Bodies (1)');
  await expectVolume(frame, cut);
  await expect.poll(async () => {
    const px = await pixelAt(page, onBox, 1);
    return /^\d/.test(px) && rgb(px)[0] < 180 ? 'body' : px;
  }, { timeout: 20_000 }).toBe('body');

  // 5. Leave Extrude 2 suppressed, then Back and reopen: the tree comes back as it was.
  // (Back while the save is still on its way asks first: test 12 holds the save to show it.)
  await rowMenu(frame, cyl, 'suppress');
  await expect(cyl).toHaveAttribute('data-suppressed', '1');
  await expectSaved(frame);
  expect(await headerDirty(page), 'saved: the header shows no unsaved work').toBeNull();
  await backByPointer(page);
  await expect(partRow).toHaveCount(1);
  const again = await openPart(page, partRow);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(historyLabels(again)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  await expect(featureRow(again, 'Extrude 2')).toHaveAttribute('data-suppressed', '1');
  await expect(featureRow(again, 'Extrude 2').locator('.tree-sub')).toHaveText('Suppressed');
  await expect(featureRow(again, 'Extrude 1')).not.toHaveAttribute('data-suppressed', '1');
  await expect(again.locator('[data-cad-tree] [data-rollback-bar]')).toHaveAttribute('aria-valuenow', '4');
  await expect(bodiesLabel(again)).toHaveText('Bodies (1)');
  await expectVolume(again, 8000);
  await shot(page, 'p1-doc-reopened');

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 6

test('cad:p1-document-tabs a header rename then an edit does not conflict; an edit from a second tab says "Changed in another tab" and Reload adopts it', async ({ page, context, request }) => {
  const { seen, frame: a } = await freshPart(page, request);
  await addBlock(page);
  await expectSaved(a);

  // Rename in the header crumb (the host's prompt); the tree's part row follows it.
  await page.locator('#workspace-overlay [data-ws-title]').click();
  await expect(page.locator('#modal-prompt')).toBeVisible();
  await page.locator('#pm-input').fill('Housing');
  await page.locator('#pm-confirm').click();
  await expect(page.locator('#modal-prompt')).toBeHidden();
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toHaveText(/Magnusim CAD\s*›\s*Housing/);
  await expect(a.locator('[data-cad-tree] [data-part-name] > .tree-row .tl')).toHaveText('Housing');
  // Then an edit (a sketch): it saves, with no conflict chip and no dialog.
  await addSketch(page, { circle: true, at: [60, 0], size: [10] });
  await expect(historyLabels(a)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2']);
  await expectSaved(a);
  await expect(a.locator('[data-chip="save"][data-state="conflict"]')).toHaveCount(0);
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await expect(page.locator('#modal-prompt')).toBeHidden();
  await expect(a.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('#plugin-studies-section li[data-plugin="cad"] .tl')).toHaveText('Housing');

  // A second tab opens the same Part.
  const page2 = await context.newPage();
  const seen2 = await watchPage(page2);
  await page2.goto(page.url());
  const b = page2.frameLocator('#workspace-frame');
  await expect(b.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect(historyLabels(b)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2']);
  await expect(b.locator('[data-cad-tree] [data-part-name] > .tree-row .tl')).toHaveText('Housing');

  // Tab A adds a block and saves; tab B, not knowing, suppresses Extrude 1: B's save is refused and B says why.
  // Both write the model with ws.files on the etag they last read or wrote (host API 1.2).
  // A write is begun (POST /api/plugin-files/uploads, with its if_match), sent, then committed;
  // the host checks the etag when the write begins and again when it commits.
  const commits = (p) => {
    const seenCommits = [];
    p.on('response', (r) => {
      if (r.request().method() === 'POST' && /\/api\/plugin-files\/uploads(\/[^/]+\/commit)?$/.test(r.url().split('?')[0])) seenCommits.push(r);
    });
    return seenCommits;
  };
  const aCommits = commits(page);
  const bCommits = commits(page2);
  await addSolid(page, { at: [50, 0, 0] });
  await expect(historyLabels(a)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Sketch 3', 'Extrude 2']);
  await expectSaved(a);
  expect(aCommits.length, 'tab A saved with ws.files').toBeGreaterThan(0);
  expect(aCommits.map((r) => r.status()).filter((st) => !(st >= 200 && st < 300)), "tab A's writes were accepted").toEqual([]);
  await rowMenu(b, featureRow(b, 'Extrude 1'), 'suppress');
  const chip = b.locator('[data-chip="save"][data-state="conflict"]');
  await expect(chip).toBeVisible({ timeout: 20_000 });
  // Tab B's write was refused by the host on its etag: 409 "changed".
  await expect.poll(() => bCommits.length).toBeGreaterThan(0);
  expect(bCommits.at(-1).status()).toBe(409);
  expect((await bCommits.at(-1).json()).code).toBe('changed');
  await expect(chip.locator('.cad-chip-v')).toHaveText('Changed in another tab');
  await expect(chip.getByRole('button', { name: 'Reload' })).toBeVisible();
  await shot(page2, 'p1-doc-conflict');
  // Tab A's part is untouched, and still says Saved.
  await expect(historyLabels(a)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Sketch 3', 'Extrude 2']);
  await expect(featureRow(a, 'Extrude 1')).not.toHaveAttribute('data-suppressed', '1');
  await expectSaved(a);

  // Reload adopts tab A's version; tab B can edit again.
  await shot(page2, 'p15-conflict');
  await chip.getByRole('button', { name: 'Reload' }).click();
  await expect(historyLabels(b)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Sketch 3', 'Extrude 2']);
  await expect(featureRow(b, 'Extrude 1')).not.toHaveAttribute('data-suppressed', '1');
  await expect(b.locator('[data-chip="save"][data-state="conflict"]')).toHaveCount(0);
  await rowMenu(b, featureRow(b, 'Extrude 2'), 'suppress');
  await expect(featureRow(b, 'Extrude 2')).toHaveAttribute('data-suppressed', '1');
  await expectSaved(b);

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen2.csp, 'CSP violations (tab 2)').toEqual([]);
  // The browser itself logs the host's 409 answer to tab B's refused write (the conflict this
  // test makes) as a failed resource load; nothing else may be logged.
  const conflict409 = /^Failed to load resource: the server responded with a status of 409 \(Conflict\) \(http:\/\/[^/]+\/api\/plugin-files\/uploads(\/[^/]+\/commit)?\)$/;
  expect(seen2.errors.filter((e) => conflict409.test(e)).length, 'the refused write, once').toBe(1);
  expect(seen2.errors.filter((e) => !conflict409.test(e)), 'console errors (tab 2)').toEqual([]);
  await page2.close();
});

// ---------------------------------------------------------------- 7

test('cad:p1-document-params width = 40 mm drives an Extrude; changing width updates the volume', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tree = frame.locator('[data-cad-tree]');

  await runCommand(frame, 'modify.parameters');
  const params = frame.locator('[data-cad-panel="params"]');
  await expect(params.locator('[data-panel-title]')).toHaveText('Parameters');
  await expect(params.locator('[data-params-empty]')).toHaveText('No parameters yet');
  await params.locator('[aria-label="New parameter name"]').fill('width');
  await params.locator('[aria-label="New parameter expression"]').fill('40 mm');
  await params.locator('[data-param-add-btn]').click();
  await expect(params.locator('[data-param-row="width"] [data-param-value]')).toHaveText('40 mm');
  await expect(tree.locator('[data-params-row] .tl')).toHaveText('Parameters (1)');
  await params.locator('[data-panel-done]').click();
  await expect(params).toHaveCount(0);

  // A 20 x 20 sketch extruded "width".
  await addSketch(page, { size: [20, 20] });
  await tb.locator('[data-command="solid.extrude"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  await setField(panel, 'distance', 'width');
  await expect(panel.locator('.nui[data-field="distance"] [data-nui-after]')).toHaveText('= 40 mm');
  await panel.locator('[data-panel-done]').click();
  await expectVolume(frame, 40 * 20 * 20);

  // Change width: the solid follows.
  await runCommand(frame, 'modify.parameters');
  const wexpr = params.locator('[data-param-row="width"] .nui input');
  await wexpr.fill('65 mm');
  await wexpr.press('Enter');
  await expect(params.locator('[data-param-row="width"] [data-param-value]')).toHaveText('65 mm');
  await expectVolume(frame, 65 * 20 * 20);
  await shot(page, 'p1-doc-params');
  await params.locator('[data-panel-done]').click();
  await expectSaved(frame);
  // The extrude panel shows the new value of its expression.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  await expect(panel.locator('.nui[data-field="distance"] input')).toHaveValue('width');
  await expect(panel.locator('.nui[data-field="distance"] [data-nui-after]')).toHaveText('= 65 mm');
  await panel.locator('[data-panel-done]').click();

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 8

test('cad:p1-document-plugin-off with CAD off the Part row is greyed with its reason; on again it opens as it was', { tag: '@serial' }, async ({ page, request }) => {
  const { seen, frame, row } = await freshPart(page, request);
  await addBlock(page);
  await expectVolume(frame, 8000);
  await expectSaved(frame);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();

  try {
    // Settings > Plugins > Magnusim CAD > Disable.
    const step = await openSettingsPlugins(page);
    const cadRow = step.locator('[data-plugin-key="cad"]');
    await expect(cadRow).toHaveAttribute('data-plugin-status', 'enabled');
    // Review round 2: the row promised sketches and STEP editing before CAD had them. Since P2/P3 it
    // names what ships (sketches, extrude, STEP) and nothing that does not (revolve, fillet, assemblies);
    // since SD no boxes or cylinders (solids come from sketches), and the enclosure for CFD; since P4a
    // revolve, sweep, loft, fillet, chamfer, shell and reference geometry; since P4b splines, offsets,
    // projected edges, patterns and mirrors; still nothing of V1 (assemblies, drawings).
    await expect(cadRow.locator('.wiz-pref-copy > strong')).toHaveText(`Magnusim CAD v${CAD_VERSION} · bundled`);
    await expect(cadRow.locator('.wiz-pref-copy > span').first()).toHaveText('Parametric parts in their own workspace: sketches with dimensions and constraints, splines, offsets, sketch mirrors and patterns, and edges projected from the model; extrude, revolve, sweep and loft; fillet, chamfer, shell and booleans; linear and circular patterns and mirrors; reference planes, axes and points; an enclosure around the part for CFD; named parameters; and STEP import, editing and export.');
    await expect(cadRow).not.toContainText(/assembl|drawing|boxes|cylinders/i);
    await cadRow.locator('[data-plugin-toggle="cad"]').click();
    // Off, and still listed so it can be turned on again (G11).
    await expect(cadRow).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 });
    await expect(cadRow.locator('[data-plugin-toggle="cad"]')).toHaveText('Enable');
    expect((await cadPluginRow(request))?.status).toBe('disabled');
    await closeSettings(page);

    // The Part stays in STUDIES, greyed, with the reason and a way to fix it; it no longer opens, and no new Part can be made.
    await expect(row).toHaveClass(/is-unavailable/);
    await expect(row.locator('> .tree-row')).toHaveCSS('opacity', '0.55');
    await expect(row.locator('[data-plugin-study-reason]')).toContainText('Requires the Magnusim CAD plugin');
    await expect(row.locator('[data-plugin-study-reason] button')).toHaveText('Open Settings → Plugins');
    await expect(page.locator('#plugin-studies-section [data-plugin-study-new="cad:part"]')).toHaveCount(0);
    await shot(page, 'p1-doc-plugin-off');
    // Clicking it does not open it: the host marks no open action on the row, and after its
    // click handling (the next frame and task) the address and the overlay are unchanged.
    await expect(row.locator('> .tree-row')).not.toHaveAttribute('data-plugin-study-open', /.*/);
    const urlBefore = page.url();
    await row.locator('> .tree-row .tl').click();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
    expect(page.url()).toBe(urlBefore);
    expect(page.url()).not.toMatch(/\/ws\//);
    await expect(page.locator('#workspace-overlay')).toBeHidden();
    await expect(page.locator('#workspace-frame')).toHaveCount(0);

    // The reason's link opens Settings > Plugins: CAD's row is there, Off, with Enable, which turns it on again.
    await row.locator('[data-plugin-study-reason] button').click();
    const step2 = page.locator('#setup-wizard .wiz-pane[data-wiz-step="5"]');
    await expect(step2).toBeVisible();
    await expect(step2.locator('[data-plugin-key="incompressible_flow"]')).toBeVisible();
    const cadRow2 = step2.locator('[data-plugin-key="cad"]');
    await expect(cadRow2).toHaveAttribute('data-plugin-status', 'disabled');
    await expect(cadRow2.locator('.wiz-plugin-status')).toHaveText('Off');
    await expect(cadRow2.locator('[data-plugin-toggle="cad"]')).toHaveText('Enable');
    await cadRow2.locator('[data-plugin-toggle="cad"]').click();
    await expect(cadRow2).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 30_000 });
    await expect(cadRow2.locator('[data-plugin-toggle="cad"]')).toHaveText('Disable');
    await closeSettings(page);
    expect((await cadPluginRow(request))?.status).toBe('enabled');
  } finally {
    await ensureCadOn(request);
  }

  await expect(row).not.toHaveClass(/is-unavailable/);
  await expect(row.locator('[data-plugin-study-reason]')).toHaveCount(0);
  const again = await openPart(page, row);
  await expect(historyLabels(again)).toHaveText(['Sketch 1', 'Extrude 1']);
  await expectVolume(again, 8000);
  await shot(page, 'p1-doc-plugin-on-again');

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 9

/**
 * CAD's row in Settings > Plugins while its manifest does not parse: bundled (where
 * its folder is), named as the manifest's name line still gives it ("Magnusim CAD";
 * no version can be read), "Failed to load", and what the TOML parser found, with its
 * line and column and the file's name, never its path.
 */
async function expectBrokenRow(cadRow) {
  await expect(cadRow).toHaveAttribute('data-plugin-status', 'error');
  await expect(cadRow).toHaveAttribute('data-plugin-source', 'bundled');
  await expect(cadRow.locator('.wiz-pref-copy > strong')).toHaveText('Magnusim CAD v0.0.0 · bundled');
  await expect(cadRow.locator('.wiz-plugin-status')).toHaveText('Failed to load');
  const error = cadRow.locator('.wiz-plugin-error[role="alert"]');
  await expect(error).toHaveText(/^manifest\.toml is not valid TOML \(line \d+, column \d+\): /);
  await expect(error).not.toContainText('bundled-plugins');
}

test('cad:p1-document-broken-manifest with a broken CAD manifest the core loads, and the CAD rows say why', { tag: '@serial' }, async ({ page, request }) => {
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, 'Part 1');
  // The new Part opened by itself: back to the project once its first save is stored.
  await expectSaved(await partOpened(page));
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();

  const restore = breakManifest();
  let restored = false;
  try {
    // The app reloads with the broken plugin (Settings > Plugins > Reload plugins, then a fresh page).
    const step = await openSettingsPlugins(page);
    await step.locator('[data-plugins-reload]').click();
    await expect(step.locator('.wiz-plugin-note')).toHaveText('Plugins reloaded.');
    await expectBrokenRow(step.locator('[data-plugin-key="cad"]'));
    await closeSettings(page);

    const seen = await watchPage(page);
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, projectId, { timeout: 90_000 });
    // The core itself is fine: its tree, its sections, its own buttons.
    await expect(page.locator('#left-tree')).toBeVisible();
    await expect(page.locator('#geometries-section .geo-head')).toContainText('GEOMETRIES (0)');
    await expect(page.locator('#btn-import-geometry')).toBeVisible();
    // The Part is still listed, greyed, and says why.
    const part = page.locator('#plugin-studies-section li[data-plugin="cad"]');
    await expect(part).toHaveCount(1);
    await expect(part).toHaveClass(/is-unavailable/);
    // It names the plugin the Part needs as the user knows it, with the app's link to Settings.
    await expect(part.locator('[data-plugin-study-reason]')).toHaveText('Requires the Magnusim CAD plugin. Open Settings → Plugins');
    await expect(part.locator('[data-plugin-study-reason] button')).toHaveClass('plugin-study-settings');
    await expect(page.locator('#plugin-studies-section [data-plugin-study-new="cad:part"]')).toHaveCount(0);
    await shot(page, 'p1-doc-broken-manifest-tree');
    // Settings shows CAD's own row with the load error.
    const step2 = await openSettingsPlugins(page);
    await expectBrokenRow(step2.locator('[data-plugin-key="cad"]'));
    await expect(step2.locator('[data-plugin-key="incompressible_flow"]')).toHaveAttribute('data-plugin-status', 'enabled');
    await shot(page, 'p1-doc-broken-manifest');

    // The manifest is fixed: Reload plugins brings CAD back.
    restored = restore();
    expect(restored, 'manifest.toml restored byte for byte').toBe(true);
    await step2.locator('[data-plugins-reload]').click();
    await expect(step2.locator('.wiz-plugin-note')).toHaveText('Plugins reloaded.');
    await expect(step2.locator('[data-plugin-key="cad"]')).toHaveAttribute('data-plugin-status', 'enabled');
    await closeSettings(page);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  } finally {
    if (!restored) restore();
    await request.post(`${baseUrl()}/api/worker`, { data: { method: 'registry.reload', params: {} } });
    await ensureCadOn(request);
  }
  await expect(row).not.toHaveClass(/is-unavailable/);
  const frame = await openPart(page, row);
  await expect(frame.locator('[data-cad-tree] [data-tree-empty="history"]')).toHaveText('No features yet');
});

// ---------------------------------------------------------------- 10

const CARD = ['font-size', 'font-family', 'color', 'line-height', 'background-color', 'border-top-color', 'border-top-width', 'border-top-style', 'border-top-left-radius', 'box-shadow', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
const SECTION = ['font-size', 'font-weight', 'color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-color', 'border-top-width', 'border-top-style', 'border-bottom-color', 'border-bottom-width', 'border-bottom-style'];
const LIST = ['margin-top', 'padding-left', 'list-style-type'];
const HEAD = ['font-size', 'font-weight', 'color', 'display', 'justify-content', 'align-items', 'gap', 'margin-bottom'];
const ROW = ['font-size', 'font-weight', 'font-family', 'color', 'line-height', 'display', 'align-items', 'gap', 'min-height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-left-radius', 'background-color', 'cursor'];
const TWISTY = ['width', 'min-height', 'color', 'font-size', 'font-weight'];
const LABEL = ['font-size', 'font-weight', 'color', 'white-space'];
const EMPTY = ['font-size', 'font-weight', 'color', 'padding-top', 'padding-bottom', 'list-style-type'];
const PANEL = ['font-size', 'font-family', 'color', 'background-color', 'border-top-color', 'border-top-width', 'border-right-color', 'border-bottom-color', 'border-top-left-radius', 'box-shadow', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
const PANEL_HEAD = ['display', 'align-items', 'gap', 'margin-bottom', 'padding-bottom', 'border-bottom-color', 'border-bottom-width', 'border-bottom-style'];
const TITLE = ['font-size', 'font-weight', 'color', 'font-family'];
const FOOT = ['display', 'justify-content', 'align-items', 'gap', 'margin-top', 'padding-top', 'border-top-color', 'border-top-width', 'border-top-style'];
const DONE = ['font-size', 'font-weight', 'font-family', 'color', 'line-height', 'background-color', 'border-top-color', 'border-top-width', 'border-top-style', 'border-top-left-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'min-width', 'cursor'];
const DELETE = ['font-size', 'font-weight', 'font-family', 'color', 'line-height', 'background-color', 'border-top-width', 'padding-top', 'padding-left', 'text-decoration-line', 'cursor'];

/**
 * The core's empty state (".sim-empty", STUDIES' "No study yet"). Since D33 STUDIES cannot show it
 * in a project with no study (CAD's kind opens from its header button, host API 1.4), so then the
 * same class is measured in the core's own list (#simulations-section), where the core's CSS gives it.
 */
async function coreEmptyStyle(page) {
  const row = page.locator('#plugin-studies-section [data-plugin-studies-empty]');
  if (await row.count()) return styleOf(row, EMPTY);
  return page.locator('#simulations-section .tree-root').first().evaluate((ul, names) => {
    const li = document.createElement('li');
    li.className = 'sim-empty';
    li.textContent = 'No study yet';
    ul.appendChild(li);
    const s = getComputedStyle(li);
    const out = Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n)]));
    li.remove();
    return out;
  }, EMPTY);
}

test('cad:p1-document-parity tree rows, the flyout panel and Done match the core LeftTree and PanelChrome', async ({ page, request }) => {
  // ---- The core, read now: the sample project's tree and its Geometry flyout (PanelChrome).
  await openProject(page, SAMPLE_PROJECT);
  const coreTree = page.locator('#left-tree');
  const simTree = page.locator('#simulations-tree');
  const coreFolder = simTree.locator('li.tree-node:has(> ul) > .tree-row').first(); // "Elbow", with a twisty
  const coreLeaf = simTree.locator('li.tree-node:not(:has(> ul)) > .tree-row').first(); // "Body1", no twisty
  await expect(coreFolder.locator('.tw')).toHaveText(/[-+]/);
  const core = {
    card: await styleOf(coreTree, CARD),
    section: await styleOf(page.locator('#simulations-section'), SECTION),
    list: await styleOf(page.locator('#simulations-section .tree-root'), LIST),
    head: await styleOf(page.locator('#simulations-section .geo-head'), HEAD),
    folder: await styleOf(coreFolder, ROW),
    folderH: await heightOf(coreFolder),
    leaf: await styleOf(coreLeaf, ROW),
    leafH: await heightOf(coreLeaf),
    twisty: await styleOf(coreFolder.locator('.tw'), TWISTY),
    label: await styleOf(coreLeaf.locator('.tl'), LABEL),
    empty: await coreEmptyStyle(page),
  };
  await coreLeaf.hover();
  core.hover = (await styleOf(coreLeaf, ['background-color']))['background-color'];
  // Geometry row: selects it and opens the Geometry flyout (Delete + Done).
  const geometryRow = simTree.locator('.tree-row', { has: page.locator('.tl', { hasText: /^Geometry$/ }) }).first();
  await geometryRow.click();
  const corePanel = page.locator('#panel-geometry');
  await expect(corePanel.locator('.tree-panel-done')).toBeVisible();
  core.selected = await styleOf(simTree.locator('.tree-node.selected > .tree-row'), ROW);
  core.panel = await styleOf(corePanel, PANEL);
  core.panelHead = await styleOf(corePanel.locator('.mat-panel-head'), PANEL_HEAD);
  core.title = await styleOf(corePanel.locator('.mat-panel-title'), TITLE);
  core.foot = await styleOf(corePanel.locator('.mat-panel-foot'), FOOT);
  core.done = await styleOf(corePanel.locator('.tree-panel-done'), DONE);
  core.doneH = await heightOf(corePanel.locator('.tree-panel-done'));
  core.del = await styleOf(corePanel.locator('.mat-clear-link'), DELETE);
  core.delH = await heightOf(corePanel.locator('.mat-clear-link'));
  const shots = shotsDir();
  const coreTreePng = shots ? await coreTree.screenshot() : null;
  const corePanelPng = shots ? await page.locator('#tree-detail').screenshot() : null;
  await corePanel.locator('.tree-panel-done').click();
  await expect(corePanel).toBeHidden();
  // The values the proposal names are what the core computes (a sanity check that the read worked).
  expect(core.leaf['min-height']).toBe('24px');
  expect(core.selected['background-color']).toBe('rgb(215, 232, 255)');
  expect(core.done['min-width']).toBe('72px');

  // ---- The CAD workspace.
  const { seen, frame } = await freshPart(page, request);
  const tree = frame.locator('[data-cad-tree]');
  const cad = {
    card: await styleOf(tree, CARD),
    // HISTORY sits between sections as SIMULATIONS does (PART, the first, has no line above).
    section: await styleOf(tree.locator('[data-tree-section="history"]'), SECTION),
    list: await styleOf(tree.locator('[data-tree-section="history"] .tree-root'), LIST),
    head: await styleOf(tree.locator('.geo-head'), HEAD),
    folder: await styleOf(tree.locator('[data-tree-node="origin"] > .tree-row'), ROW),
    folderH: await heightOf(tree.locator('[data-tree-node="origin"] > .tree-row')),
    twisty: await styleOf(tree.locator('[data-tree-node="origin"] > .tree-row .tw'), TWISTY),
    empty: await styleOf(tree.locator('[data-tree-empty="history"]'), EMPTY),
  };
  const tb = frame.locator('[data-cad-toolbar]');
  await addSketch(page);
  await tb.locator('[data-command="solid.extrude"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  const boxRow = featureRow(frame, 'Extrude 1');
  await expect(boxRow).toHaveClass(/selected/);
  cad.selected = await styleOf(boxRow.locator('> .tree-row'), ROW);
  cad.panel = await styleOf(panel, PANEL);
  cad.panelHead = await styleOf(panel.locator('.mgk-panel-head'), PANEL_HEAD);
  cad.title = await styleOf(panel.locator('[data-panel-title]'), TITLE);
  cad.foot = await styleOf(panel.locator('.mgk-panel-foot'), FOOT);
  cad.done = await styleOf(panel.locator('[data-panel-done]'), DONE);
  cad.doneH = await heightOf(panel.locator('[data-panel-done]'));
  cad.del = await styleOf(panel.locator('[data-panel-delete]'), DELETE);
  cad.delH = await heightOf(panel.locator('[data-panel-delete]'));
  const cadPanelPng = shots ? await frame.locator('[data-cad-flyout]').screenshot() : null;
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  // An unselected leaf row: click the part row (a heading) so Extrude 1 is no longer selected.
  await tree.locator('[data-part-name] > .tree-row').click();
  await expect(boxRow).not.toHaveClass(/selected/);
  cad.leaf = await styleOf(boxRow.locator('> .tree-row'), ROW);
  cad.leafH = await heightOf(boxRow.locator('> .tree-row'));
  cad.label = await styleOf(boxRow.locator('> .tree-row .tl'), LABEL);
  await boxRow.locator('> .tree-row').hover();
  cad.hover = (await styleOf(boxRow.locator('> .tree-row'), ['background-color']))['background-color'];
  await page.mouse.move(5, 500);

  // ---- Equal, property by property (a mismatch prints both values).
  expect(cad.card, 'tree card').toEqual(core.card);
  expect(cad.section, 'tree section').toEqual(core.section);
  expect(cad.list, 'rows below the section head').toEqual(core.list);
  expect(cad.head, 'section head').toEqual(core.head);
  expect(cad.folder, 'row with a twisty').toEqual(core.folder);
  expect(cad.folderH, 'row with a twisty: height').toBe(core.folderH);
  expect(cad.leaf, 'row without a twisty').toEqual(core.leaf);
  expect(cad.leafH, 'row without a twisty: height').toBe(core.leafH);
  expect(cad.twisty, 'twisty').toEqual(core.twisty);
  expect(cad.label, 'row label').toEqual(core.label);
  expect(cad.empty, 'empty state').toEqual(core.empty);
  expect(cad.hover, 'row hover').toBe(core.hover);
  expect(cad.selected, 'selected row').toEqual(core.selected);
  expect(cad.panel, 'flyout panel').toEqual(core.panel);
  expect(cad.panelHead, 'panel head').toEqual(core.panelHead);
  expect(cad.title, 'panel title').toEqual(core.title);
  expect(cad.foot, 'panel foot').toEqual(core.foot);
  expect(cad.done, 'Done').toEqual(core.done);
  expect(cad.doneH, 'Done: height').toBe(core.doneH);
  expect(cad.del, 'Delete').toEqual(core.del);
  expect(cad.delH, 'Delete: height').toBe(core.delH);

  if (shots) {
    // Side by side: the core first, CAD second.
    const cadTreePng = await tree.screenshot();
    writeFileSync(join(shots, 'p1-core-tree.png'), coreTreePng);
    writeFileSync(join(shots, 'p1-cad-tree.png'), cadTreePng);
    writeFileSync(join(shots, 'p1-core-panel.png'), corePanelPng);
    writeFileSync(join(shots, 'p1-cad-panel.png'), cadPanelPng);
    const pair = await page.context().newPage();
    const img = (png, caption) => `<figure><figcaption>${caption}</figcaption><img src="data:image/png;base64,${png.toString('base64')}"></figure>`;
    for (const [name, left, right, what] of [
      ['p1-tree-pair.png', coreTreePng, cadTreePng, 'tree'],
      ['p1-panel-pair.png', corePanelPng, cadPanelPng, 'flyout panel'],
    ]) {
      await pair.setContent(
        `<style>body{margin:0;padding:16px;background:#f0f2f7;font:12px "Segoe UI",sans-serif;display:flex;gap:24px;align-items:flex-start}figure{margin:0}figcaption{margin:0 0 6px;color:#344054;font-weight:600}</style>${img(left, `Core ${what} (sample project)`)}${img(right, `CAD ${what} (Part workspace)`)}`,
      );
      await pair.screenshot({ path: join(shots, name), fullPage: true });
    }
    await pair.close();
  }

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- review round 1

test('cad:p1-document-save-chip undo, redo, undo within 1.5 s ends on "Saved"; a reopened Part says Saved', async ({ page, request }) => {
  const { seen, frame, row } = await freshPart(page, request);
  const chip = frame.locator('[data-chip="save"]');
  // One edit: a sketch.
  await addSketch(page);
  await expect(historyLabels(frame)).toHaveText(['Sketch 1']);
  await expectSaved(frame);
  // The bug needed the first undo to be written at once and the redo to wait (the
  // old 1.5 s window): so start more than 1.5 s after the last save, as a person
  // looking at the part would.
  await page.waitForTimeout(1600);
  await frame.locator('[data-cad-tree] [data-part-name] > .tree-row').click();
  const t0 = Date.now();
  await page.keyboard.press('Control+z');
  await expect(historyLabels(frame)).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(historyLabels(frame)).toHaveText(['Sketch 1']);
  await page.keyboard.press('Control+z');
  await expect(frame.locator('[data-cad-tree] [data-tree-empty="history"]')).toHaveText('No features yet');
  expect(Date.now() - t0, 'undo, redo, undo within 1.5 s').toBeLessThan(1500);
  // It said "Saving…" for good before the fix (data-state pending until the next edit).
  await expect(chip).toHaveText('Saved', { timeout: 3000 });
  await expect(chip).toHaveAttribute('data-state', 'saved');

  // Reopened: the same (empty) part, and the chip says Saved there too (it showed nothing).
  await backByPointer(page);
  const again = await openPart(page, row);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(again.locator('[data-cad-tree] [data-tree-empty="history"]')).toHaveText('No features yet');
  await expect(again.locator('[data-chip="save"]')).toHaveText('Saved');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// L3 (host API 1.6): the Part's exit hook saves before anything leaves, so with a save on its
// way Back, Home and the browser's Back wait for it (the header: "Saving Part 1", with Cancel)
// instead of asking "Leave without saving?" (P1.5). Nothing is lost either way.
test('cad:p1-document-leave-waits with a save on its way, Back, Home and the browser Back wait for it; Cancel keeps the Part and the edit; a save dropped on the way out is written again', async ({ page, request }) => {
  const { seen, frame, row } = await freshPart(page, request);
  await addBlock(page);
  await expectSaved(frame);
  const box1 = featureRow(frame, 'Extrude 1');

  // The save is held at its commit (the step that replaces the file): it stays on its way.
  const hold = await holdCommits(page);
  await rowMenu(frame, box1, 'suppress');
  await expect(box1).toHaveAttribute('data-suppressed', '1');
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saving…');
  await expect.poll(() => hold.held()).toBe(1);
  // The host's header marks the unsaved work with the Part's words.
  await expect.poll(() => headerDirty(page)).toBe('Changes to Part 1 are not saved yet.');

  // Back (the header's), as a person clicks it: the exit waits for the save; Cancel keeps the
  // page and the edit.
  await backByPointer(page, { waits: true });
  await shot(page, 'l3-leave-waits-for-save');
  await cancelLeave(page);
  await expect(box1).toHaveAttribute('data-suppressed', '1');
  // Home (in the covered workbench: clicked from script, as the app's own G7 test does).
  await page.evaluate(() => document.getElementById('wb-home').click());
  await expectLeaveWaitsForSave(page);
  await cancelLeave(page);
  await expect(page.locator('#home')).toBeHidden();
  // The browser's Back.
  const url = page.url();
  await page.goBack();
  await expectLeaveWaitsForSave(page);
  await cancelLeave(page);
  await expect.poll(() => page.url()).toBe(url);
  await expect(box1).toHaveAttribute('data-suppressed', '1');
  expect(hold.held(), 'the save is still on its way').toBe(1);

  // The save lands: Saved, the header is clean, and Back leaves without a question.
  await hold.release();
  await expectSaved(frame);
  await expect.poll(() => headerDirty(page)).toBeNull();
  await backByPointer(page);
  let again = await openPart(page, row);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(featureRow(again, 'Extrude 1')).toHaveAttribute('data-suppressed', '1');

  // A save dropped on the way out (the test fails its write, as a dropped connection would):
  // the exit's save writes it again, then the workspace closes; nothing is lost.
  const hold2 = await holdCommits(page);
  await rowMenu(again, featureRow(again, 'Extrude 1'), 'suppress');
  await expect(featureRow(again, 'Extrude 1')).not.toHaveAttribute('data-suppressed', '1');
  await expect.poll(() => hold2.held()).toBe(1);
  await backByPointer(page, { waits: true });
  await hold2.abort();
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#workspace-frame')).toHaveCount(0);
  again = await openPart(page, row);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(featureRow(again, 'Extrude 1')).not.toHaveAttribute('data-suppressed', '1');
  await expect(again.locator('[data-chip="save"]')).toHaveText('Saved');
  expect(seen.csp, 'CSP violations').toEqual([]);
  // The one error is the commit this test failed on purpose.
  expect(seen.errors.filter((e) => !/net::ERR_FAILED \(http:\/\/[^/]+\/api\/plugin-files\/uploads\/[^/]+\/commit\)$/.test(e)), 'console errors').toEqual([]);
});

// P1.5 review round 1: the other ways out the host guards, with CAD's own words. A link
// typed to another project waits for the save (L3: the exit hook saves first; Cancel keeps
// the page); turning CAD off in Settings runs no exit hook and asks "Turn off Magnusim CAD?".
// Cancel keeps the page, the edit, and CAD on.
test('cad:p1-document-leave-elsewhere with a save on its way, a typed link to another project waits for it and Settings > Plugins > Disable asks; Cancel keeps the edit and CAD on', { tag: '@serial' }, async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addBlock(page);
  await expectSaved(frame);
  const box1 = featureRow(frame, 'Extrude 1');
  const hold = await holdCommits(page);
  await rowMenu(frame, box1, 'suppress');
  await expect(box1).toHaveAttribute('data-suppressed', '1');
  await expect.poll(() => hold.held()).toBe(1);
  await expect.poll(() => headerDirty(page)).toBe('Changes to Part 1 are not saved yet.');
  const stillHere = async () => {
    await expect(page.locator('#workspace-overlay')).toBeVisible();
    await expect(box1).toHaveAttribute('data-suppressed', '1');
    await expect(frame.locator('[data-chip="save"]')).toHaveText('Saving…');
    expect(hold.held(), 'the save is still on its way').toBe(1);
  };

  // A link to another project, typed in the address bar.
  const url = page.url();
  await page.evaluate((pid) => {
    location.hash = `#/p/${pid}`;
  }, SAMPLE_PROJECT);
  await expectLeaveWaitsForSave(page);
  await cancelLeave(page);
  await expect.poll(() => page.url()).toBe(url);
  await stillHere();

  // Settings > Plugins > Magnusim CAD > Disable, from the workspace's own header.
  await page.locator('#workspace-overlay .ws-header-right #wb-prefs').click();
  const wizard = page.locator('#setup-wizard');
  await expect(wizard).toBeVisible();
  await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
  const cadRow = wizard.locator('.wiz-pane[data-wiz-step="5"] [data-plugin-key="cad"]');
  await expect(cadRow).toHaveAttribute('data-plugin-status', 'enabled');
  await cadRow.locator('[data-plugin-toggle="cad"]').click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Turn off Magnusim CAD?');
  // CAD's message in parentheses, without its own full stop there.
  await expect(page.locator('#cf-copy')).toHaveText('Its workspace is open with changes that are not saved (Changes to Part 1 are not saved yet). Turning it off closes the workspace and discards them.');
  await expect(page.locator('#cf-confirm')).toHaveText('Turn off');
  // Cancel has the keyboard: Enter (like Escape) keeps the work; Turn off takes a click.
  await expect(page.locator('#cf-cancel')).toHaveText('Cancel');
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await shot(page, 'p15-turn-off-question');
  await answerLeave(page, false);
  await expect(cadRow).toHaveAttribute('data-plugin-status', 'enabled');
  await expect(cadRow.locator('.wiz-plugin-status')).toHaveText('On');
  await expect(cadRow.locator('[data-plugin-toggle="cad"]')).toHaveText('Disable');
  await page.locator('#wiz-skip').click();
  await expect(wizard).toBeHidden();
  await stillHere();
  expect((await cadPluginRow(request))?.status).toBe('enabled');

  // The save lands: Saved, the header is clean, and the edit is kept.
  await hold.release();
  await expectSaved(frame);
  await expect.poll(() => headerDirty(page)).toBeNull();
  await expect(box1).toHaveAttribute('data-suppressed', '1');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- review round 2: leaving with a change waiting

/** Ten tree-twisty clicks (Origin and Bodies, five each), as a person looking around the tree. */
async function lookAroundTree(page, frame) {
  const origin = frame.locator('[data-cad-tree] [data-tree-node="origin"] > .tree-row .tw');
  const bodies = frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tw');
  for (let i = 0; i < 5; i++) {
    await origin.click();
    await page.waitForTimeout(150);
    await bodies.click();
    await page.waitForTimeout(150);
  }
}

test('cad:p1-document-leave-side-back the mouse side Back button over the part, with a save on its way, waits for it (L3); Cancel keeps the change', async ({ page, request }) => {
  const { seen, frame, row } = await freshPart(page, request);
  await addBlock(page);
  await addSolid(page, { at: [50, 0, 0] });
  await expectSaved(frame);
  const hold = await holdCommits(page);
  await rowMenu(frame, featureRow(frame, 'Extrude 2'), 'suppress');
  await expect.poll(() => hold.held()).toBe(1);
  const expected = await historyState(frame);
  expect(expected).toBe('Sketch 1, Extrude 1, Sketch 2, Extrude 2 (S)');
  // The pointer stays over the part, and the button goes down and up as a finger
  // presses it; the browser goes back on the release, as it does for the real button.
  const fb = await page.locator('#workspace-frame').boundingBox();
  const x = fb.x + fb.width * 0.55;
  const y = fb.y + fb.height * 0.55;
  await page.mouse.move(x, y, { steps: 4 });
  const url = page.url();
  const sideBack = async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'back', buttons: 8, clickCount: 1 });
    await page.waitForTimeout(90);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'back', buttons: 0, clickCount: 1 });
    await cdp.detach();
  };
  await sideBack();
  await expectLeaveWaitsForSave(page);
  await cancelLeave(page);
  await expect.poll(() => page.url()).toBe(url);
  expect(await historyState(frame)).toBe(expected);
  await hold.release();
  await expectSaved(frame);
  // Saved: the same button leaves without a question.
  await sideBack();
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 60_000 });
  expect(page.url()).not.toBe(url);
  const again = await openPart(page, row);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  expect(await historyState(again)).toBe(expected);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-document-leave-tree-twisties folders opened and closed do not hold up the next edit: a suppress right after them survives Back', async ({ page, request }) => {
  const { seen, frame, row } = await freshPart(page, request);
  const chip = frame.locator('[data-chip="save"]');
  for (let i = 0; i < 3; i++) await addSolid(page, { at: [50 * i, 0, 0] });
  await expectSaved(frame);
  await page.waitForTimeout(9500); // a person looks at the part: the save budget is full again
  await frame.locator('[data-cad-tree] [data-part-name] > .tree-row').click();
  const originOpen = async () => (await frame.locator('[data-cad-tree] [data-tree-node="origin"]').getAttribute('aria-expanded')) === 'true';
  const bodiesOpen = async () => (await frame.locator('[data-cad-tree] [data-bodies-folder]').getAttribute('aria-expanded')) === 'true';
  const folders = [await originOpen(), await bodiesOpen()];
  // Ten twisty clicks used up the whole budget before (each was a save), so the
  // suppress below waited for the next 1.5 s slot, and Back 600 ms later lost it.
  await lookAroundTree(page, frame);
  expect([await originOpen(), await bodiesOpen()], 'both folders flipped (five clicks each)').toEqual([!folders[0], !folders[1]]);
  // The save chip's states from here on, with when each began (the frame's clock).
  await workspaceFrame(page).evaluate(() => {
    const state = () => document.querySelector('[data-chip="save"]')?.getAttribute('data-state') ?? null;
    const log = (window.__saveChipLog = [{ s: state(), t: performance.now() }]);
    new MutationObserver(() => {
      const s = state();
      if (s !== log[log.length - 1].s) log.push({ s, t: performance.now() });
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  });
  await rowMenu(frame, featureRow(frame, 'Extrude 3'), 'suppress');
  await expect(featureRow(frame, 'Extrude 3')).toHaveAttribute('data-suppressed', '1');
  // Written at once: its write starts with no wait for a slot ("Saving…" at once, never "pending"
  // for the 1.5 s of a slot), however long the server takes to answer (the save round trip is
  // about 20 ms on an idle PC, longer with parallel e2e workers on the same server).
  await expect(chip).toHaveText('Saved', { timeout: 30_000 });
  await expect(chip).toHaveAttribute('data-state', 'saved');
  const chipLog = await workspaceFrame(page).evaluate(() => window.__saveChipLog);
  const pendingMs = chipLog.reduce((ms, e, i) => (e.s === 'pending' ? ms + ((chipLog[i + 1]?.t ?? e.t) - e.t) : ms), 0);
  expect(chipLog.map((e) => e.s), 'the suppress was written').toContain('saving');
  expect(pendingMs, `time waiting for a save slot (${JSON.stringify(chipLog)})`).toBeLessThan(500);
  const expected = await historyState(frame);
  // Back a moment later, with the pointer over the part and no key or button in the frame.
  await page.waitForTimeout(150);
  await page.mouse.move(800, 520);
  await page.goBack();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const again = await openPart(page, row);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  expect(await historyState(again)).toBe(expected);
  await expect(featureRow(again, 'Extrude 3')).toHaveAttribute('data-suppressed', '1');
  // The folders as they were left (written with the suppress).
  const a = again.locator('[data-cad-tree] [data-tree-node="origin"]');
  const b = again.locator('[data-cad-tree] [data-bodies-folder]');
  expect([(await a.getAttribute('aria-expanded')) === 'true', (await b.getAttribute('aria-expanded')) === 'true']).toEqual([!folders[0], !folders[1]]);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

/** Where the camera looks from (unit vector from the target to the camera), rounded. */
const viewDir = (page) =>
  workspaceFrame(page).evaluate(() => {
    const c = window.__CAD__.services.viewport.get().handle.camera();
    const d = c.position.map((v, i) => v - c.target[i]);
    const n = Math.hypot(...d);
    return d.map((v) => Math.round((v / n) * 100) / 100);
  });

test('cad:p1-document-keys keys work as soon as the Part opens and after Settings, with no click in it; the hint shows only while the frame has no focus', async ({ page, request }) => {
  const { seen, frame, row } = await freshPart(page, request);
  const hint = frame.locator('[data-chip="keys"]');
  // The host gave the page the keyboard when it connected: no hint.
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  await expect(hint).toHaveCount(0);
  expect(await workspaceFrame(page).evaluate(() => document.hasFocus())).toBe(true);
  await addBlock(page);
  await expectSaved(frame);
  await backByPointer(page);
  // Reopened from the project's tree (a click on the host, not in the frame): a key works at once.
  // Key 5 is the Top view: the camera then looks down from +Z.
  const again = await openPart(page, row);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  await expect(hint).toHaveCount(0);
  expect(await viewDir(page)).not.toEqual([0, 0, 1]);
  await page.keyboard.press('5');
  await expect.poll(() => viewDir(page)).toEqual([0, 0, 1]);
  // The host's header takes the keyboard: the hint says so, and keys go to the host.
  await headerTakesKeyboard(page);
  await expect(hint).toHaveText('Click here to use keyboard shortcuts');
  await expect(hint).toHaveCSS('font-size', '12px');
  // It is the dock's last chip: when it goes, the chips before it stay where they are.
  await expect(again.locator('[data-cad-dock] [data-chip]').last()).toHaveAttribute('data-chip', 'keys');
  await page.keyboard.press('7');
  expect(await viewDir(page)).toEqual([0, 0, 1]);
  // The app's Settings opened and closed: the host gives the page the keyboard back, with no click in it.
  await page.locator('#workspace-overlay .ws-header-right #wb-prefs').click();
  await expect(page.locator('#setup-wizard')).toBeVisible();
  await page.locator('#wiz-skip').click();
  await expect(page.locator('#setup-wizard')).toBeHidden();
  await expect(hint).toHaveCount(0);
  await page.keyboard.press('7');
  await expect.poll(() => viewDir(page)).toEqual([0.58, -0.58, 0.58]);
  // A click in the frame after the hint: it goes, and keys keep working.
  await headerTakesKeyboard(page);
  await expect(hint).toBeVisible();
  await again.locator('[data-cad-tree] [data-part-name] > .tree-row').click();
  await expect(hint).toHaveCount(0);
  await page.keyboard.press('5');
  await expect.poll(() => viewDir(page)).toEqual([0, 0, 1]);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-document-keys-undo Ctrl+Z / Ctrl+Y reach the Part with no click in it: after Settings closes, the last edit is undone and redone', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSketch(page);
  await expect(historyLabels(frame)).toHaveText(['Sketch 1']);
  // Focus leaves the frame (the host's header), then the app's Settings opens and closes.
  await headerTakesKeyboard(page);
  await expect(frame.locator('[data-chip="keys"]')).toBeVisible();
  await page.locator('#workspace-overlay .ws-header-right #wb-prefs').click();
  await expect(page.locator('#setup-wizard')).toBeVisible();
  await page.locator('#wiz-skip').click();
  await expect(page.locator('#setup-wizard')).toBeHidden();
  await expect(frame.locator('[data-chip="keys"]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(frame.locator('[data-cad-tree] [data-tree-empty="history"]')).toHaveText('No features yet');
  await page.keyboard.press('Control+y');
  await expect(historyLabels(frame)).toHaveText(['Sketch 1']);
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-document-long-names 64-character names end in an ellipsis inside the card; the row buttons stay clear', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tree = frame.locator('[data-cad-tree]');
  await addBlock(page);
  const fname = LONG('A very long feature name');
  const bname = LONG('Another extremely long body name');
  expect(fname).toHaveLength(64);
  expect(bname).toHaveLength(64);
  // Rename the feature (F2) and the body (its pencil).
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').click();
  await page.keyboard.press('F2');
  const fin = tree.locator('input[aria-label="Feature name"]');
  await fin.fill(fname);
  await fin.press('Enter');
  const frow = tree.locator('[data-feature-row][data-feature-type="extrude"]').first();
  await expect(frow.locator('> .tree-row .tl')).toHaveText(fname);
  await tree.locator('[data-bodies-folder] > .tree-row').click();
  const brow = tree.locator('[data-body-row]').first();
  await brow.locator('[data-body-act="rename"]').click();
  const bin = tree.locator('input[aria-label="Body name"]');
  await bin.fill(bname);
  await bin.press('Enter');
  await expect(brow.locator('> .tree-row .tl')).toHaveText(bname);

  const measure = (loc) =>
    loc.evaluate((tl) => {
      const row = tl.closest('.tree-row');
      const card = tl.closest('[data-cad-tree]');
      const r = tl.getBoundingClientRect();
      const acts = [...row.querySelectorAll('.tree-acts button, .tree-sub, .cad-badge')].map((b) => b.getBoundingClientRect());
      return {
        textOverflow: getComputedStyle(tl).textOverflow,
        overflow: getComputedStyle(tl).overflowX,
        cut: tl.scrollWidth > tl.clientWidth,
        labelRight: r.right,
        rowRight: row.getBoundingClientRect().right,
        overlaps: acts.filter((a) => a.left < r.right - 0.5 && a.right > r.left && a.width > 0).length,
        acts: acts.length,
        card: { scroll: card.scrollWidth, client: card.clientWidth },
      };
    });
  for (const [what, loc] of [
    ['feature', frow.locator('> .tree-row .tl')],
    ['body', brow.locator('> .tree-row .tl')],
  ]) {
    const m = await measure(loc);
    expect(m.textOverflow, `${what} label ends in an ellipsis`).toBe('ellipsis');
    expect(m.overflow, `${what} label clips`).toBe('hidden');
    expect(m.cut, `${what} label is cut (so the ellipsis shows)`).toBe(true);
    expect(m.labelRight, `${what} label inside its row`).toBeLessThanOrEqual(m.rowRight);
    expect(m.overlaps, `${what} row buttons clear of the label`).toBe(0);
    expect(m.card.scroll, `${what}: the tree card does not scroll sideways`).toBe(m.card.client);
  }
  // The body row's simulation toggle (LINK), eye and pencil are all there, beside (not over) the name.
  expect((await measure(brow.locator('> .tree-row .tl'))).acts).toBe(3);
  // The full name is the label's tooltip once it is cut.
  await frow.locator('> .tree-row .tl').hover();
  await expect(frow.locator('> .tree-row .tl')).toHaveAttribute('title', fname);
  await brow.locator('> .tree-row .tl').hover();
  await expect(brow.locator('> .tree-row .tl')).toHaveAttribute('title', bname);
  // Suppressed: the "Suppressed" note keeps its room too.
  await rowMenu(frame, frow, 'suppress');
  await expect(frow.locator('.tree-sub')).toHaveText('Suppressed');
  const ms = await measure(frow.locator('> .tree-row .tl'));
  expect(ms.overlaps, 'the Suppressed note clear of the label').toBe(0);
  expect(ms.card.scroll).toBe(ms.card.client);
  // A name that fits has no tooltip.
  await tree.locator('[data-tree-node="origin:top"] > .tree-row .tl').hover();
  await expect(tree.locator('[data-tree-node="origin:top"] > .tree-row .tl')).not.toHaveAttribute('title', /.*/);
  await shot(page, 'p1-doc-long-names');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- review round 3

test('cad:p1-document-operation Operation is offered only when a body is made before the feature; Extrude 2 (a square at X = 20) joins Extrude 1', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const panel = frame.locator('[data-cad-panel="feature"]');
  const op = panel.locator('[data-field="op"] select');
  // Extrude 1: the first solid, nothing before it to join, cut or intersect.
  await addSketch(page);
  await tb.locator('[data-command="solid.extrude"]').click();
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(op).toHaveCount(0);
  await setField(panel, 'distance', '20');
  await panel.locator('[data-panel-done]').click();
  // Extrude 2 of a square at X = 20 (touching Extrude 1's +X face): Extrude 1's body is before it.
  await addSketch(page, { at: [20, 0] });
  await tb.locator('[data-command="solid.extrude"]').click();
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 2');
  await setField(panel, 'distance', '20');
  await expect(op).toHaveValue('new');
  await expect(op.locator('option')).toHaveText(['New body', 'Join', 'Cut', 'Intersect']);
  await panel.locator('[data-panel-done]').click();
  await expect(bodiesLabel(frame)).toHaveText('Bodies (2)');
  // Reopened, Extrude 1 still has no Operation, although Extrude 2 made a body after it.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(op).toHaveCount(0);
  await panel.locator('[data-panel-done]').click();
  // Extrude 2 joins Extrude 1: one body of 40 x 20 x 20.
  await featureRow(frame, 'Extrude 2').locator('> .tree-row').dblclick();
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 2');
  await op.selectOption('join');
  await panel.locator('[data-panel-done]').click();
  await expect(bodiesLabel(frame)).toHaveText('Bodies (1)');
  await expectVolume(frame, 16000);
  await expect(volumeValue(frame)).toHaveText('16,000 mm³');
  await expect(featureRow(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-document-nothing-to-join a first feature stored as Join keeps its Operation row and says why it does nothing; New body fixes it', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const panel = frame.locator('[data-cad-panel="feature"]');
  await addBlock(page);
  // Extrude 2 (a cube at X = 20) joins Extrude 1; with Extrude 1 suppressed, no body is made before it any more.
  await addSolid(page, { at: [20, 0, 0], op: 'join' });
  await expectVolume(frame, 16000);
  await rowMenu(frame, featureRow(frame, 'Extrude 1'), 'suppress');
  const box2 = featureRow(frame, 'Extrude 2');
  await expect(box2).toHaveAttribute('data-state', 'error');
  await expect(box2.locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', "What's wrong: Nothing to join: Extrude 2 shares no face with a body made before it");
  // Its panel keeps the Operation row (so it can be set back), with the same reason in the foot.
  await box2.locator('> .tree-row').dblclick();
  await expect(panel.locator('[data-field="op"] select')).toHaveValue('join');
  await expect(panel).toContainText('Nothing to join: Extrude 2 shares no face with a body made before it');
  await panel.locator('[data-field="op"] select').selectOption('new');
  await panel.locator('[data-panel-done]').click();
  await expect(box2).toHaveAttribute('data-state', 'ok');
  await expect(bodiesLabel(frame)).toHaveText('Bodies (1)');
  await expectVolume(frame, 8000);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// P1.5 review round 1: the reason said "no body made before Box 2 touches it" for a Cut flush
// against Box 1's face and for a Join along an edge, although both touch Box 1. (Since SD the
// solids are sketched and extruded.)
test('cad:p1-document-nothing-to-op-touching a Cut flush against a face, and a Join along an edge only, say what is missing', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const panel = frame.locator('[data-cad-panel="feature"]');
  const op = panel.locator('[data-field="op"] select');
  const reason = panel.locator('[data-run-reason]');
  await addBlock(page);
  // A square at X = 20 extruded 20 mm with Cut: it sits flush against Extrude 1's +X face, so it cuts nothing away.
  await addSketch(page, { at: [20, 0] });
  await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
  await setField(panel, 'distance', '20');
  await op.selectOption('cut');
  const box2 = featureRow(frame, 'Extrude 2');
  const cutWhy = 'Nothing to cut: Extrude 2 does not overlap any body made before it (touching is not enough)';
  await expect(box2).toHaveAttribute('data-state', 'error');
  await expect(reason).toHaveText(cutWhy);
  await expect(box2.locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', `What's wrong: ${cutWhy}`);
  await shot(page, 'p15r1-cut-flush');
  await expect(bodiesLabel(frame)).toHaveText('Bodies (1)');
  await expectVolume(frame, 8000);
  // Intersect in the same place: nothing in common either.
  await op.selectOption('intersect');
  await expect(reason).toHaveText('Nothing to intersect: Extrude 2 does not overlap any body made before it (touching is not enough)');
  // Join there shares the face: one body of 40 x 20 x 20.
  await op.selectOption('join');
  await expect(box2).toHaveAttribute('data-state', 'ok');
  await expect(reason).toHaveCount(0);
  await expectVolume(frame, 16000);
  // Back to Cut and Done (it stays red, cutting nothing); then a cube at (20, 20, 0) joined: it meets
  // Extrude 1 only along the edge x = 20, y = 20. Touching, but no shared face.
  await op.selectOption('cut');
  await panel.locator('[data-panel-done]').click();
  await expectVolume(frame, 8000);
  await addSolid(page, { at: [20, 20, 0], op: 'join' });
  const edge = featureRow(frame, 'Extrude 3');
  const joinWhy = (n) => `Nothing to join: Extrude ${n} shares no face with a body made before it`;
  await expect(edge).toHaveAttribute('data-state', 'error');
  await edge.locator('> .tree-row').dblclick();
  await expect(reason).toHaveText(joinWhy(3));
  await panel.locator('[data-panel-done]').click();
  await expect(bodiesLabel(frame)).toHaveText('Bodies (1)');
  await shot(page, 'p15r1-join-edge');
  await expectVolume(frame, 8000);
  // Only a corner in common (20, 20, 20): the same.
  await addSolid(page, { at: [20, 20, 20], op: 'join' });
  const corner = featureRow(frame, 'Extrude 4');
  await expect(corner).toHaveAttribute('data-state', 'error');
  await expect(corner.locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', `What's wrong: ${joinWhy(4)}`);
  await expectVolume(frame, 8000);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-document-reload-files a reload after a save shows the saved model, read with ws.files (host API 1.2)', async ({ page, request }) => {
  const { seen, frame, projectId } = await freshPart(page, request);
  const studyId = studyIdOf(page);
  await addBlock(page);
  // A Ø8 circle at (10, 10) extruded from z = -5, 30 long, with Cut.
  await addSolid(page, { circle: true, at: [10, 10, -5], size: [8, 30], op: 'cut' });
  const cut = 8000 - Math.PI * 16 * 20;
  await expectVolume(frame, cut);
  await expectSaved(frame);
  await shot(page, 'p15-box-cut');
  // Stored by ws.files: the study record holds the pointer (store "files"), the file has no version
  // token of its own (the host's etag is its version), and it holds both features.
  const rec = await (await request.get(`${baseUrl()}/api/plugin-studies/get?${new URLSearchParams({ project_id: projectId, plugin: 'cad', study_id: studyId })}`)).json();
  expect(rec.study.doc).toEqual({ rel: `studies/${studyId}/model.json`, schema: 1, store: 'files', view: `studies/${studyId}/view.json` });
  const stored = await storedModel(request, projectId, studyId);
  expect(stored.json.format).toBe('magnusim-cad/model');
  expect(stored.json.etag).toBeUndefined();
  expect(stored.json.doc.features.map((f) => f.name)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  // Reload the page: the model comes back through ws.files (stat, then read), never ws.data.
  const reads = [];
  page.on('request', (r) => {
    const u = decodeURIComponent(r.url());
    if (u.includes(`studies/${studyId}/model.json`) || /\/api\/plugin-data\/read/.test(u)) reads.push(`${r.method()} ${u.replace(baseUrl(), '').split('&project_id')[0]}`);
  });
  const dataReads = [];
  page.on('request', (r) => {
    if (/\/api\/plugin-data\/read/.test(r.url())) dataReads.push(r.postDataJSON()?.rel);
  });
  await page.reload();
  const again = page.frameLocator('#workspace-frame');
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect(historyLabels(again)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  await expectVolume(again, cut);
  await expect(again.locator('[data-chip="save"]')).toHaveText('Saved');
  expect(reads.some((r) => r.startsWith('GET /api/plugin-files/stat')), reads.join('\n')).toBe(true);
  expect(reads.some((r) => r.startsWith('GET /api/plugin-files/read')), reads.join('\n')).toBe(true);
  expect(dataReads, 'the model is not read with ws.data').not.toContain(`studies/${studyId}/model.json`);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-document-p1-part-moves a Part saved by P1 (ws.data) opens with nothing lost and moves to ws.files once; the P1 file is kept', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  // A Part as a P1 build left it: the pointer says "data", and model.json carries ws.data's own version token.
  const created = await (await request.post(`${baseUrl()}/api/plugin-studies/create`, { data: { project_id: projectId, plugin: 'cad', kind: 'part', title: 'Old part' } })).json();
  const studyId = created.study.id;
  const rel = `studies/${studyId}/model.json`;
  const pointer = { rel, schema: 1, store: 'data', view: `studies/${studyId}/view.json` };
  const rec = await (await request.get(`${baseUrl()}/api/plugin-studies/get?${new URLSearchParams({ project_id: projectId, plugin: 'cad', study_id: studyId })}`)).json();
  const upd = await request.post(`${baseUrl()}/api/plugin-studies/update`, { data: { project_id: projectId, plugin: 'cad', study_id: studyId, rev: rec.study.rev, patch: { doc: pointer } } });
  expect(upd.ok(), await upd.text()).toBe(true);
  const p1File = {
    format: 'magnusim-cad/model',
    etag: '7.s_p1tab',
    saved_at: '2026-09-30T20:00:00.000Z',
    doc: {
      schema: 1,
      units: { length: 'mm', angle: 'deg' },
      params: [],
      bodies: { b_p1: { name: 'Body 1', color: '#bdc9db' } },
      features: [{ id: 'f_p1', type: 'box', name: 'Old box', op: 'new', creates: 'b_p1', scope: [], origin: ['0 mm', '0 mm', '0 mm'], size: ['30 mm', '20 mm', '10 mm'] }],
      meta: { created_at: '2026-09-30T19:00:00.000Z', written_by: '0.1.0' },
    },
  };
  const w = await request.post(`${baseUrl()}/api/plugin-data/write`, { data: { project_id: projectId, plugin: 'cad', rel, doc: p1File } });
  expect(w.ok(), await w.text()).toBe(true);
  const p1Bytes = await (await request.get(`${baseUrl()}/api/plugin-files/read?${new URLSearchParams({ project_id: projectId, plugin: 'cad', rel })}`)).text();

  // Opened: the same part, nothing lost, saying Saved. Its Box is a removed feature since SD
  // (decision 2026-10-01): the row stays, red, saying so (cad-sd-enclosure.spec.ts has the rest).
  await openProject(page, projectId);
  const row = page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: 'Old part' }) });
  const frame = await openPart(page, row);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(historyLabels(frame)).toHaveText(['Old box']);
  await expect(featureRow(frame, 'Old box')).toHaveAttribute('data-state', 'error');
  await expect(featureRow(frame, 'Old box').locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', "What's wrong: This part uses a removed feature (Old box)");
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved');
  // L3 review B2: the Part says so when it opens, with the one step that fixes it.
  await expect(frame.locator('[data-chip="removed"] .cad-chip-v')).toHaveText('This Part uses a removed feature: Old box');
  await expect(frame.locator('[data-chip="removed"] [data-chip-action]')).toHaveText(['Suppress it']);
  // An edit saves, and the reopened Part shows both (what the user sees comes first; P1.5 review round 1).
  await addBlock(page);
  await expectSaved(frame);
  // Back: the removed Box does not build, so the Part is not added to the project (link review
  // L1: never a partial design); the app's question says what to do (not "Fix, retry", which
  // cannot be done for a removed type), and Leave anyway leaves.
  await backByPointer(page, { asks: true });
  await expect(page.locator('#cf-heading')).toHaveText("Couldn't update the project");
  await expect(page.locator('#cf-copy')).toHaveText('Magnusim CAD: Old box is a removed feature (Box). Suppress or delete it, then leave. The project is unchanged.');
  await expect(page.locator('#cf-confirm')).toHaveText('Leave anyway');
  await page.locator('#cf-confirm').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const again = await openPart(page, row);
  await expect(historyLabels(again)).toHaveText(['Old box', 'Sketch 1', 'Extrude 1']);
  await expect(bodiesLabel(again)).toHaveText('Bodies (1)');
  await expect(again.locator('[data-chip="volume"]')).toHaveText('Volume8000 mm³');
  // Moved: the pointer says "files", model.json was written through ws.files (no token of its own),
  // and the P1 file is kept byte for byte beside it, and not moved again on the reopen.
  const after = await (await request.get(`${baseUrl()}/api/plugin-studies/get?${new URLSearchParams({ project_id: projectId, plugin: 'cad', study_id: studyId })}`)).json();
  expect(after.study.doc).toEqual({ ...pointer, store: 'files' });
  const moved = await storedModel(request, projectId, studyId);
  expect(moved.json.etag).toBeUndefined();
  expect(moved.json.doc.features.map((f) => f.name)).toEqual(['Old box', 'Sketch 1', 'Extrude 1']);
  // Nothing of the old Part was dropped: its Box and its body's name are in the stored model as they were.
  expect(moved.json.doc.features[0]).toEqual(p1File.doc.features[0]);
  expect(moved.json.doc.bodies.b_p1).toEqual({ name: 'Body 1', color: '#bdc9db' });
  const kept = await request.get(`${baseUrl()}/api/plugin-files/read?${new URLSearchParams({ project_id: projectId, plugin: 'cad', rel: `studies/${studyId}/model.p1.json` })}`);
  expect(kept.ok()).toBe(true);
  expect(await kept.text()).toBe(p1Bytes);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
