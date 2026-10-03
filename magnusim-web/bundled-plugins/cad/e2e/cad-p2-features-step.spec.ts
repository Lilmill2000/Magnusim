// P2-FEATURES' drafts of the P2 exit flows (docs/p2p3-plan.md §5.1), in the
// real host frame with the real kernel: Import STEP by the file picker and by a
// drop (progress, "0 problems", the STEP's body, its volume), the 512 MB rule
// before any upload, Delete faces of the flange's holes clicked in the
// viewport, Press-pull of the top face, Split by the Right plane (named
// pieces), Mass properties, Check, Measure, Export STEP (the download, read
// back by Import STEP), and a reopen that reads the stored BREP only (no
// import_step, no heal reaches the kernel worker). The Vortex fluid domain
// (§5.3) needs Daniel's file (CAD_E2E_VORTEX_STEP; skipped without it, and it fails
// with the path when the variable names no file). INTEGRATE folds these into e2e/cad-p2-step.spec.js.
// window.__CAD__ is used only to read projections and kernel geometry for
// where to click, and (helpers.ts addSolid) to set a sketched 20 mm block up:
// there is no Box since decision 2026-10-01. The flows under test go through
// the mouse, keys and file inputs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSolid, baseUrl, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures', 'kernel');
const FLANGE = join(FIXTURES, 'flange.step');
const BOX20 = join(FIXTURES, 'box20.step');
const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';

type Loc = ReturnType<FrameLocator['locator']>;
type V3 = [number, number, number];
type W = { __CAD__: { services: any }; __kernelOps?: string[] };

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel]');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const volumeChip = (frame: FrameLocator) => frame.locator('[data-chip="volume"]');
const expectSaved = (frame: FrameLocator) => expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 30_000 });

let shots = 0;
/** A page screenshot into CAD_E2E_SHOTS (when set), named by the test and the open panel. */
async function shot(page: Page, what: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const name = `${test.info().title.split(' ')[0].replace(/[^a-z0-9-]+/gi, '_')}-${String(++shots).padStart(2, '0')}-${what}`;
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Done in the open panel (a screenshot of it first). */
async function done(page: Page, p: Loc) {
  const feature = p.locator('[data-feature-panel]');
  const tool = p.locator('[data-tool-panel]');
  const kind = (await feature.count()) ? await feature.getAttribute('data-feature-panel') : (await tool.count()) ? await tool.getAttribute('data-tool-panel') : 'panel';
  await shot(page, kind ?? 'panel');
  await p.locator('[data-panel-done]').click();
}

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, row, projectId };
}

/** Import STEP from the toolbar: the browser's file picker gets `path`. */
async function importByPicker(page: Page, frame: FrameLocator, path: string) {
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(path);
}

/** Drop a file on the frame as the browser does (DataTransfer with the file's bytes). */
async function dropFile(page: Page, name: string, bytes: Buffer | { size: number }) {
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
      const fire = (type: string) => document.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire('dragenter');
      fire('dragover');
      fire('drop');
    },
    { name, b64, size },
  );
}

/** Wait for the import panel to finish, then Done. Returns the panel's diagnostics line. */
async function finishImport(page: Page, frame: FrameLocator) {
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="import"]')).toBeVisible();
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  const diag = await p.locator('[data-import-diagnostics]').textContent();
  await done(page, p);
  await expect(p).toHaveCount(0);
  return diag;
}

/** Evaluate in the frame (state reads only); `fn` reads window itself (evaluate passes only `arg`). */
const cad = <T, A = undefined>(page: Page, fn: (arg: A) => T, arg?: A) => workspaceFrame(page).evaluate(fn as never, arg) as Promise<Awaited<T>>;

/** Page coordinates of a model point (the viewport's own projection). */
async function at(page: Page, p: V3): Promise<[number, number]> {
  const s = await cad(page, (q: V3) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(q) as [number, number] | null, p);
  expect(s, `projection of ${p}`).not.toBeNull();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + s![0], box.y + s![1]];
}

/** A point on the wall of each cylindrical face of the first body that the camera sees (its far side, near the top). */
async function holeWallPoints(page: Page): Promise<V3[]> {
  return cad(page, async () => {
    const s = (window as unknown as W).__CAD__.services;
    // The first body with cylindrical faces (the flange).
    let t: any = null;
    for (const b of s.doc.state.get().rebuild.bodies) {
      t = await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'exact', face_mass: true });
      if (t.result.faces.some((f: any) => f.type === 'cylinder')) break;
    }
    const cam = s.viewport.get().handle.camera();
    const view = [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1]];
    const n = Math.hypot(view[0], view[1]) || 1;
    return t.result.faces
      .filter((f: any) => f.type === 'cylinder')
      .map((f: any) => [f.axis.origin[0] + (f.radius * view[0]) / n, f.axis.origin[1] + (f.radius * view[1]) / n, f.bbox[5] - 2]);
  });
}

async function clickModel(page: Page, p: V3) {
  const [x, y] = await at(page, p);
  await page.mouse.click(x, y);
}

/** Open the tree's Bodies folder (its rows are clicked to pick bodies). */
async function openBodies(frame: FrameLocator) {
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
}

async function openMass(frame: FrameLocator) {
  await tb(frame).locator('[data-command="inspect.mass"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-tool-panel="inspect.mass"]')).toBeVisible();
  return p;
}

test('cad:p2-features-import flange by the picker and box20 by a drop: progress, "0 problems", the STEP body, the volume', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // Nothing to edit yet: the P2 commands say why.
  await expect(tb(frame).locator('[data-command="modify.press-pull"]')).toHaveAttribute('data-disabled-reason', 'Make or import a body first');
  await importByPicker(page, frame, FLANGE);
  await expect(panel(frame).locator('.mgk-panel-title')).toHaveText('Imported 1 (flange.step)');
  expect(await finishImport(page, frame)).toBe('0 problems');
  await expect(featureRow(frame, 'Imported 1 (flange.step)')).toHaveAttribute('data-state', 'ok');
  await expect(frame.locator('[data-cad-tree] [data-body-row]')).toHaveCount(1);
  await expect(volumeChip(frame)).toHaveText(/96,858\.4 mm³$/);
  const mass = await openMass(frame);
  await expect(mass.locator('[data-mass-value="faces"]')).toHaveText('10, 24');
  await expect(mass.locator('[data-mass-value="size"]')).toHaveText('100 mm × 100 mm × 10 mm');
  await done(page, mass);
  // A drop imports too.
  await dropFile(page, 'box20.step', readFileSync(BOX20));
  expect(await finishImport(page, frame)).toBe('0 problems');
  await expect(featureRow(frame, 'Imported 2 (box20.step)')).toHaveAttribute('data-state', 'ok');
  await expect(volumeChip(frame)).toHaveText('VolumeTotal of 2 bodies · 104,858 mm³');
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-features-size a 600 MB STEP is refused before anything uploads', async ({ page, request }) => {
  const { seen, frame, projectId } = await freshPart(page, request);
  // Uploads of import files (the Part's own model.json is written through ws.files too).
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().split('?')[0].endsWith('/api/plugin-files/uploads') && (r.postData() ?? '').includes('/imports/')) uploads.push(r.postData() ?? '');
  });
  await dropFile(page, 'huge.step', { size: 600 * 1024 * 1024 });
  await expect(page.locator('[data-ws-toast]').filter({ hasText: 'This STEP is 600 MB. Parts can store files up to 512 MB.' })).toBeVisible();
  await expect(panel(frame)).toHaveCount(0);
  expect(uploads).toEqual([]);
  const listed = await (await request.get(`${baseUrl()}/api/plugin-files/list?${new URLSearchParams({ project_id: projectId, plugin: 'cad', prefix: 'studies' })}`)).json();
  expect((listed.files as { rel: string }[]).filter((f) => f.rel.includes('/imports/'))).toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-features-edit Delete faces of the holes, Press-pull the top +10 mm, Split by the Right plane, Check, Measure', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  // Delete faces: the panel takes the four hole walls clicked in the viewport.
  await tb(frame).locator('[data-command="modify.delete-faces"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  const holes = await holeWallPoints(page);
  expect(holes).toHaveLength(4);
  for (let i = 0; i < holes.length; i++) {
    // The body is healed after each pick: the next hole's wall is still where it was.
    await clickModel(page, holes[i]);
    await expect(p.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(i + 1, { timeout: 30_000 });
  }
  await expect(p.locator('[data-pick-field="faces"] .cad-pick-label')).toHaveText('Faces to delete (4)');
  await expect(volumeChip(frame)).toHaveText(/100,000 mm³$/, { timeout: 30_000 });
  await done(page, p);
  await expect(featureRow(frame, 'Delete faces 1')).toHaveAttribute('data-state', 'ok');
  // Press-pull the top face (z = 10) +10 mm: select it, Q.
  await clickModel(page, [-40, -40, 10]);
  await page.keyboard.press('q');
  await expect(p.locator('[data-feature-panel="press_pull"]')).toBeVisible();
  await expect(p.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
  await expect(p.locator('[data-press-sense]')).toHaveText('Adds material: the faces move out of the body');
  await expect(volumeChip(frame)).toHaveText(/200,000 mm³$/, { timeout: 30_000 });
  await done(page, p);
  const mass = await openMass(frame);
  await expect(mass.locator('[data-mass-value="size"]')).toHaveText('100 mm × 100 mm × 20 mm');
  await expect(mass.locator('[data-mass-value="faces"]')).toHaveText('6, 12');
  await done(page, mass);
  // Split by the Right plane: two named halves.
  await tb(frame).locator('[data-command="modify.split"]').click();
  await openBodies(frame);
  const body = frame.locator('[data-cad-tree] [data-body-row]').first();
  const name = (await body.locator('.cad-body-name').textContent())!;
  await body.locator('.tree-row').first().click();
  await expect(p.locator('[data-pick-field="targets"] [data-pick-row]')).toHaveCount(1);
  await expect(p.locator('[data-split-pieces]')).toHaveText('2 bodies', { timeout: 30_000 });
  await done(page, p);
  await expect(frame.locator('[data-cad-tree] [data-body-row] .cad-body-name')).toHaveText([name, `${name} (2)`]);
  // Check: both valid.
  await tb(frame).locator('[data-command="inspect.check"]').click();
  await expect(p.locator('[data-check-summary]')).toHaveText('All 2 bodies are valid', { timeout: 30_000 });
  await done(page, p);
  // Measure: the plate's two big faces are 20 mm apart.
  await tb(frame).locator('[data-command="inspect.measure"]').click();
  await clickModel(page, [-40, -40, 20]);
  await clickModel(page, [-49.9, -20, 10]);
  await expect(p.locator('[data-measure-value="distance"]')).toBeVisible({ timeout: 30_000 });
  await done(page, p);
  await expectSaved(frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-features-reopen a reopened Part reads the stored BREP only, with the same face names', async ({ page, request }) => {
  // Every op the frame's kernel worker is asked for, from the first moment of every load.
  await page.context().addInitScript(() => {
    const w = window as unknown as W;
    w.__kernelOps = [];
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, ...rest: unknown[]) {
      const m = msg as { type?: string; op?: string } | null;
      if (m && m.type === 'call' && m.op) w.__kernelOps!.push(m.op);
      return (orig as (...a: unknown[]) => void).call(this, msg, ...rest);
    } as typeof orig;
  });
  const { seen, frame, row } = await freshPart(page, request);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  const names = () => cad(page, () => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies.map((b: any) => b.names?.faces ?? null));
  const before = await names();
  expect(before[0]).toHaveLength(10);
  expect(await cad(page, () => (window as unknown as W).__kernelOps)).toEqual(expect.arrayContaining(['import_step', 'heal', 'brep_write']));
  await expectSaved(frame);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const again = await openPart(page, row);
  await expect(featureRow(again, 'Imported 1 (flange.step)')).toHaveAttribute('data-state', 'ok', { timeout: 60_000 });
  await expect(volumeChip(again)).toHaveText(/96,858\.4 mm³$/);
  expect(await names()).toEqual(before);
  const ops = await cad(page, () => (window as unknown as W).__kernelOps);
  expect(ops).toContain('brep_read');
  expect(ops).not.toContain('import_step');
  expect(ops).not.toContain('heal');
  // The panel says where the shapes came from.
  await featureRow(again, 'Imported 1 (flange.step)').locator('> .tree-row').dblclick();
  await expect(panel(again).locator('[data-import-output="brep"]')).toHaveText(/^Loaded from the stored healed shapes in (\d+ ms|\d+\.\d s)$/);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-features-export Export STEP downloads the body (AP214), and Import STEP reads it back', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  await tb(frame).locator('[data-command="file.export-step"]').click();
  const p = panel(frame);
  await expect(p.locator('#cad-export-name')).toHaveValue('Part 1.step');
  await expect(p.locator('[data-field="schema"] select')).toHaveValue('AP214');
  const dl = page.waitForEvent('download');
  await p.locator('[data-export-run]').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('Part 1.step');
  const path = join(test.info().outputDir, 'Part 1.step');
  await download.saveAs(path);
  const text = readFileSync(path, 'utf8');
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text).toContain('AUTOMOTIVE_DESIGN');
  await expect(p.locator('[data-export-done]')).toHaveText(/^Exported Part 1\.step · [\d.]+ KB · 1 body$/);
  await done(page, p);
  // Read back: the same volume.
  await importByPicker(page, frame, path);
  await finishImport(page, frame);
  await expect(volumeChip(frame)).toHaveText('VolumeTotal of 2 bodies · 193,717 mm³');
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-features-vortex the Vortex fluid domain: an Enclosure with a 100 mm margin minus Vortex (Daniel\'s file)', async ({ page, request }) => {
  test.setTimeout(480_000);
  test.skip(!VORTEX, "needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step");
  expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP is set but there is no file at ${VORTEX}`).toBe(true);
  const ref = JSON.parse(readFileSync(join(FIXTURES, 'reference.json'), 'utf8'));
  const { seen, frame } = await freshPart(page, request);
  await importByPicker(page, frame, VORTEX);
  await finishImport(page, frame);
  await expect(volumeChip(frame)).toHaveText(/44,798,500 mm³$/);
  // Enclosure, Fixed 100 mm: the reference fluid_box (Box is gone since decision 2026-10-01).
  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  const p = panel(frame);
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  const dist = p.locator('.nui[data-field="distance"] input');
  await dist.fill('100');
  await dist.press('Enter');
  await expect(p.locator('[data-enclosure-size]')).toHaveText(/^Size: 504\.8 mm × 504\.8 mm × 1012\.8 mm · /);
  await done(page, p);
  // Combine: Cut, the enclosure the target, Vortex the tool (tree rows).
  await tb(frame).locator('[data-command="modify.combine"]').click();
  await p.locator('[data-field="op"] select').selectOption('cut');
  await openBodies(frame);
  const rows = frame.locator('[data-cad-tree] [data-body-row]');
  await rows.nth(1).locator('.tree-row').first().click();
  await expect(p.locator('[data-pick-field="tools"]')).toHaveAttribute('data-active', '1');
  await rows.nth(0).locator('.tree-row').first().click();
  // An Enclosure's body as the target turns Keep the tool bodies on (SD review round 1); this
  // test wants the fluid alone, so it turns it off, as a user may.
  const keep = p.locator('[data-switch="keep-tools"] input');
  await expect(keep).toBeChecked();
  await p.locator('[data-switch="keep-tools"] .cad-switch-label').click();
  await expect(keep).not.toBeChecked();
  await expect(volumeChip(frame)).toHaveText(/213,286,000 mm³$/, { timeout: 240_000 });
  // The tool the cut used up is still listed, plainly, and nothing in the panel says otherwise.
  await expect(p.locator('[data-pick-field="tools"] .cad-pick-name')).toHaveText(['Vortex CFD Test v1']);
  await expect(p.locator('[data-pick-error]')).toHaveCount(0);
  await done(page, p);
  const exact = await cad(page, () => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].volume as number);
  expect(Math.abs(exact / ref.cut_fluid.volume - 1)).toBeLessThan(1e-6);
  const mass = await openMass(frame);
  await expect(mass.locator('[data-mass-value="faces"]')).toHaveText(new RegExp(`^${ref.cut_fluid.faces}, `));
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-features-knit a surface-only STEP: "6 faces not in a solid", Heal all with knitting makes one 8,000 mm³ solid', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const BOX20_FACES = join(FIXTURES, 'box20-faces.step');
  expect(existsSync(BOX20_FACES), `the KERNEL fixture ${BOX20_FACES} is missing`).toBe(true);
  await importByPicker(page, frame, BOX20_FACES);
  const p = panel(frame);
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 60_000 });
  await expect(p.locator('[data-import-loose]')).toHaveText('6 faces not in a solid');
  await expect(p.locator('[data-import-shells]')).toHaveText('1 surface body: knit the faces into solids with Heal all');
  await expect(p.locator('[data-import-bodies] tbody td').nth(1)).toHaveText('Surface');
  await expect(p.locator('[data-switch="knit"] input')).toBeChecked();
  await p.locator('[data-import-heal]').click();
  await expect(p.locator('[data-import-bodies] tbody td').nth(1)).toHaveText('Solid', { timeout: 60_000 });
  await expect(p.locator('[data-import-healed]')).toHaveText('Healed at 0.001 mm, knit');
  await expect(p.locator('[data-import-shells]')).toHaveCount(0);
  // The faces are in a solid now: the panel no longer says they are not (it kept the first read's "6 faces not in a solid").
  await expect(p.locator('[data-import-loose]')).toHaveCount(0);
  await expect(p.locator('[data-import-diagnostics]').locator('xpath=..')).toContainText('6 faces were knit.');
  await expect(volumeChip(frame)).toHaveText(/8000 mm³$/, { timeout: 30_000 });
  await done(page, p);
  // Import and Heal all are one undo step: Undo takes both away, Redo brings the knit solid back.
  await page.keyboard.press('Control+z');
  await expect(featureRow(frame, 'Imported 1 (box20-faces.step)')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(featureRow(frame, 'Imported 1 (box20-faces.step)')).toHaveAttribute('data-state', 'ok');
  await expect(volumeChip(frame)).toHaveText(/8000 mm³$/, { timeout: 30_000 });
  await expectSaved(frame);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-features-measure two parallel faces of a 20 mm box are 20 mm apart; a hole of radius 5 reads 5 mm', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 20 mm block beside the flange (corner x = 100), sketched and extruded.
  await addSolid(page, { at: [100, 0, 0] });
  await importByPicker(page, frame, FLANGE);
  await finishImport(page, frame);
  await tb(frame).locator('[data-command="inspect.measure"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-tool-panel="inspect.measure"]')).toBeVisible();
  const still = () => cad(page, () => ((window as unknown as W).__CAD__.services.viewport.get().handle.state.get().animating ? 'moving' : 'still'));
  // Everything in view (the box sits beside the flange); the box's top (z = 20), then from below its bottom (z = 0).
  await page.keyboard.press('f');
  await expect.poll(still).toBe('still');
  await clickModel(page, [110, 10, 20]);
  await expect(p.locator('[data-pick-row]')).toHaveCount(1);
  await page.keyboard.press('6');
  await expect.poll(still).toBe('still');
  await clickModel(page, [110, 10, 0]);
  await expect(p.locator('[data-pick-row]')).toHaveCount(2);
  await expect(p.locator('[data-measure-value="distance"]')).toHaveText('20 mm', { timeout: 30_000 });
  await expect(p.locator('[data-measure-value="angle"]')).toHaveText('0°');
  await shot(page, 'measure-distance');
  // A third pick starts over: a hole wall of the flange, its radius.
  await page.keyboard.press('7');
  await expect.poll(still).toBe('still');
  const holes = await holeWallPoints(page);
  await clickModel(page, holes[0]);
  await expect(p.locator('[data-pick-row]')).toHaveCount(1);
  await expect(p.locator('[data-measure-value="a.radius"]')).toHaveText('5 mm', { timeout: 30_000 });
  await done(page, p);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2-features-native-delete Delete on a face of an extruded block asks in the frame: focus on Cancel, Escape keeps the Extrude; "Delete faces and heal" opens the panel', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 20 mm block, sketched and extruded.
  await addSolid(page);
  await clickModel(page, [10, 10, 20]);
  await page.keyboard.press('Delete');
  const dlg = frame.locator('[data-cad-dialog]');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('h2')).toHaveText('Delete faces of Extrude 1?');
  await expect(dlg.locator('[data-dialog-choice]')).toHaveText(['Delete feature Extrude 1', 'Delete faces and heal', 'Cancel']);
  await expect(dlg.locator('[data-dialog-choice="cancel"]')).toBeFocused();
  await shot(page, 'native-delete-dialog');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(featureRow(frame, 'Extrude 1')).toHaveCount(1);
  // Enter on the focused Cancel cancels too.
  await page.keyboard.press('Delete');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dlg).toHaveCount(0);
  await expect(featureRow(frame, 'Extrude 1')).toHaveCount(1);
  await page.keyboard.press('Delete');
  await dlg.locator('[data-dialog-choice="faces"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  // "Face 6 of Body 1", as Measure names it (P2+P3 review round 1: "Face 7 (Imported 1 (flange.step))" here,
  // "Face 3 of flange" in Measure); where it came from is the tooltip.
  await expect(p.locator('[data-pick-field="faces"] .cad-pick-name')).toHaveText([/^Face \d+ of Body 1$/]);
  await expect(p.locator('[data-pick-field="faces"] .cad-pick-name')).toHaveAttribute('title', /^Face \d+ of Body 1, from End face of Extrude 1$/);
  await shot(page, 'native-delete-panel');
  expect(seen.errors, 'console errors').toEqual([]);
});
