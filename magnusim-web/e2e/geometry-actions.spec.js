import { expect, test } from '@playwright/test';
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { prepareE2eProjectsRoot } from './prepare-projects.js';
import { getJson } from './support/compute-slot.js';
import { e2eTemp, killTree, startHost } from './support/host-server.mjs';

// Editing a project geometry (host API 1.7) as the user meets it, with the fixture plugin
// edit-demo (python/tests/fixtures/edit-plugins/edit-demo: kind Edit demo links geometry and has
// the geometry action "Edit in Demo"; its page reads the geometry and sends "Edit v2", the
// cube with its top pulled up 10 mm, with the original's names). No WSL.
//   1. The action in the tree's right-click menu (geometry and body rows), the Geometry panel
//      and the viewport's right-click on the part; an STL import shows it disabled with its
//      reason; with the plugin off it is gone.
//   2. A click makes the study "box" and opens it; a second tab opens the same study; the
//      page's context names the geometry, and the viewport's right-click passes the face (once:
//      a reload has none).
//   3. The page reads the STEP (its sha256 is source.step's) and the face table (6 faces, the
//      BC on the top named).
//   4. Adopt with BCs: Inlet on the top, Wall on the bottom, a generated mesh; Edit v2 -> the
//      host's question -> Overwrite box. The same geometry id, its row "from box"; Inlet on the
//      new top (z = 30), Wall where it was, no lost face; the mesh "Out of date"; the original
//      kept with its hash; all after a reload; the Geometry panel offers the original.
//   5. Without the original's names the top's BC is lost (the names do the work).
//   6. Save as new: "box v2" added, box stays a plain import with its study.
//   7. Keep editing: nothing changes.
//   8. A save drawn on the plain box after the adoption is refused (409 geometry_changed).
//   9. Refusals: a bad originalNames (bad_face_names), a second editor (adopted), a geometry
//      removed before the first link (the host asks; "Add as new geometry" makes a new one).
//  10. Crash: on a host whose every apply fails the adoption stops half way (fenced); after a
//      restart without the switch the recovery finishes it.
//  11. "Add as new geometry" imports the original beside the adopted one.
//  12. A removed target: after an adoption, box removed (the question says the Part stays), a
//      new box of the same name added; the Part is in STUDIES ("Its geometry box was
//      removed"), the new box is never its; its next edit asks: "Not now" adds nothing,
//      "Add as new geometry" adds "box v2" and leaves the new box as it was.
//  13. Two bodies: the viewport right-click on the second body passes that body.

const FX = resolve('python/tests/fixtures/edit-plugins/edit-demo/workspace/fixtures');
const TWO_BODIES = resolve('python/tests/fixtures/geometry/two-boxes-shared-face.brep');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const BOX_SHA = sha256(readFileSync(join(FX, 'box.step')));

function bundledIfOnly(tmp) {
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  return bundled;
}

async function newProject(request, host, title) {
  const p = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const pj = await p.json();
  expect(p.ok(), JSON.stringify(pj)).toBe(true);
  return pj.id;
}

/** Import a fixture file (edit-demo's, or a full path) as the project's newest geometry; its id. */
async function importFile(request, host, pid, file) {
  const path = isAbsolute(file) ? file : join(FX, file);
  const r = await request.post(`${host.base}/api/geometry/import`, { data: { project_id: pid, step_path: path, filename: basename(path) } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j).slice(0, 400)).toBe(true);
  return j.added.id;
}

function geomDir(host, pid, gid) {
  const root = join(host.projects, pid, 'geometries');
  for (const name of readdirSync(root)) {
    try {
      if (JSON.parse(readFileSync(join(root, name, 'id.json'), 'utf8')).id === gid) return join(root, name);
    } catch {
      /* not a geometry */
    }
  }
  return null;
}

/** The label of the face whose normal points along z (+1 top, -1 bottom), and its height. */
function faceAlong(host, pid, gid, z) {
  const meta = JSON.parse(readFileSync(join(geomDir(host, pid, gid), 'cad_preview.json'), 'utf8'));
  const f = meta.faces.find((x) => Array.isArray(x.normal) && Math.abs(x.normal[2] - z) < 1e-6);
  return { label: `face ${f.id}@Body1`, z: f.centroid[2] };
}

async function apiStudy(request, host, pid, gid) {
  const r = await request.post(`${host.base}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return { id: j.simulation.id, name: j.simulation.name };
}

async function apiBc(request, host, pid, sim, name, faces) {
  const r = await request.post(`${host.base}/api/bcs`, { data: { project_id: pid, simulation_id: sim, name, bc_type: 'Wall', faces } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return j.bc.id;
}

async function bcFaces(request, host, pid, sim, id) {
  const all = (await getJson(request, `${host.base}/api/bcs?project_id=${pid}&simulation_id=${sim}`)).boundary_conditions || [];
  const bc = all.find((b) => b.id === id) || {};
  return { faces: bc.faces || [], lost: (bc.lost_faces || []).length };
}

/** A mesh of the study marked generated (no WSL here): it must read "Out of date" after the edit. */
async function generatedMesh(request, host, pid, sim) {
  const r = await request.post(`${host.base}/api/mesh`, { data: { project_id: pid, simulation_id: sim, name: 'Mesh 1' } });
  const id = (await r.json()).mesh.id;
  const root = join(host.projects, pid, 'geometries');
  for (const g of readdirSync(root)) {
    const sims = join(root, g, 'simulations');
    let names = [];
    try {
      names = readdirSync(sims);
    } catch {
      continue;
    }
    for (const s of names) {
      let meshes = [];
      try {
        meshes = readdirSync(join(sims, s, 'meshes'));
      } catch {
        continue;
      }
      for (const m of meshes) {
        const file = join(sims, s, 'meshes', m, 'mesh.json');
        try {
          const doc = JSON.parse(readFileSync(file, 'utf8'));
          if (doc.id !== id) continue;
          writeFileSync(file, JSON.stringify({ ...doc, generated: true, live_mesh_result: { status: 'done', generate_id: 'g-e2e', n_cells: 8 } }));
          return id;
        } catch {
          /* next */
        }
      }
    }
  }
  throw new Error('no mesh folder');
}

async function openProject(page, host, pid) {
  await page.goto(`${host.base}/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

const geomRow = (page, gid) => page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);

/** The tree's right-click menu of a geometry row: its items' [label, enabled, sub-line]. */
async function treeMenu(page, gid) {
  await geomRow(page, gid).click({ button: 'right' });
  const menu = page.locator(`[data-geom-menu="${gid}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

/** Open the action from the tree's menu; the workspace frame once its page is up. */
async function editFromTree(page, pid, gid) {
  const menu = await treeMenu(page, gid);
  await menu.locator('[data-geom-action="demo"]').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/ws/edit-demo/demo/st-[0-9a-f]+$`));
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('#title')).not.toHaveText('Connecting…', { timeout: 30_000 });
  return frame;
}

const studyOf = (page) => page.evaluate(() => (location.hash.match(/\/ws\/edit-demo\/demo\/(st-[0-9a-f]+)$/) || [])[1] || '');

async function back(page, pid) {
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
}

/** The report the host shows after an update that touches the setup (an out-of-date mesh), then OK. */
async function readReport(page) {
  const modal = page.locator('#modal-confirm');
  await expect(modal).toBeVisible({ timeout: 60_000 });
  const out = { title: await page.locator('#cf-heading').textContent(), copy: await page.locator('#cf-copy').textContent() };
  await page.locator('#cf-confirm').click();
  await expect(modal).toBeHidden();
  return out;
}

async function answerQuestion(page, choice) {
  await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
  const heading = await page.locator('#lc-heading').textContent();
  const copy = await page.locator('#lc-copy').textContent();
  const newLabel = await page.locator('#lc-new').textContent();
  const overwrite = await page.locator('#lc-overwrite').textContent();
  // "Not now" is the second button of the question about a removed geometry.
  await page.locator({ new: '#lc-new', overwrite: '#lc-overwrite', not_now: '#lc-overwrite', cancel: '#lc-cancel' }[choice]).click();
  await expect(page.locator('#modal-link-choice')).toBeHidden();
  return { heading, copy, newLabel, overwrite };
}

/** A point of the viewport's canvas on the part (on this body, when given), as the viewport's own pick finds it. */
async function partPoint(page, body = 0) {
  let found = null;
  await expect
    .poll(
      async () => {
        found = await page.evaluate((want) => {
          const canvas = document.querySelector('#viewer canvas');
          if (!canvas || typeof window.__CFD_PICK_CAD__ !== 'function') return null;
          const r = canvas.getBoundingClientRect();
          const faceAt = (x, y) => {
            const top = document.elementFromPoint(x, y);
            if (!top || !top.closest('#viewer')) return '';
            const hit = window.__CFD_PICK_CAD__({ clientX: x, clientY: y });
            return hit && hit.faceId ? `${hit.solidId || 1}:${hit.faceId}` : '';
          };
          const ring = [[10, 0], [-10, 0], [0, 10], [0, -10], [7, 7], [7, -7], [-7, 7], [-7, -7]];
          for (let fy = 0.3; fy <= 0.7; fy += 0.04) {
            for (let fx = 0.3; fx <= 0.7; fx += 0.04) {
              const x = Math.round(r.left + r.width * fx);
              const y = Math.round(r.top + r.height * fy);
              const key = faceAt(x, y);
              if (!key || (want && Number(key.split(':')[0]) !== want)) continue;
              if (ring.some(([dx, dy]) => faceAt(x + dx, y + dy) !== key)) continue;
              const [solidId, faceId] = key.split(':').map(Number);
              return { x, y, faceId, solidId };
            }
          }
          return null;
        }, body);
        return !!found;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  return found;
}

test.describe('geometry actions (host API 1.7)', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const tmp = e2eTemp('geometry-actions');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({ name: 'geometry-actions', tmp, projects, bundledDir: bundledIfOnly(tmp), pluginsFrom: 'python/tests/fixtures/edit-plugins' });
  });
  test.afterAll(() => host?.stop());

  test('the action in the tree, the panel and the viewport; an STL shows why not; off, it is gone @plugins', async ({ page, request }) => {
    test.setTimeout(240_000);
    const pid = await newProject(request, host, 'Actions places');
    const stl = await importFile(request, host, pid, 'box.stl');
    const gid = await importFile(request, host, pid, 'box.step');
    await openProject(page, host, pid);
    // The tree: the geometry row and its body row.
    let menu = await treeMenu(page, gid);
    const item = menu.locator('[data-geom-action="demo"]');
    await expect(item).toBeEnabled();
    await expect(item).toContainText('Edit in Demo');
    await expect(item).toContainText('Open this part in the Demo editor.');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await page.locator(`#left-tree [data-w16-geom="${gid}"] [data-w16-body="1"] > .tree-row`).first().click({ button: 'right' });
    await expect(page.locator(`[data-geom-menu="${gid}"] [data-geom-action="demo"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    // The STL: disabled, with the reason under it.
    menu = await treeMenu(page, stl);
    await expect(menu.locator('[data-geom-action="demo"]')).toBeDisabled();
    await expect(menu.locator('[data-geom-action-reason="1"]')).toHaveText(
      'box is a mesh (STL); Edit in Demo needs a STEP, IGES or BREP part.',
    );
    await page.keyboard.press('Escape');
    // The Geometry panel (a click on the row opens it).
    await geomRow(page, gid).locator('.tl').click();
    const panelBtn = page.locator('[data-geometry-action-button="demo"]');
    await expect(panelBtn).toBeVisible({ timeout: 30_000 });
    await expect(panelBtn).toBeEnabled();
    // The viewport: right-click on the part.
    const at = await partPoint(page);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await expect(page.locator('#face-ctx-menu')).toBeVisible();
    await expect(page.locator('#face-ctx-menu [data-geom-action="demo"]')).toContainText('Edit in Demo');
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    // The plugin off: nowhere.
    expect((await request.post(`${host.base}/api/plugins/edit-demo/disable`)).ok()).toBe(true);
    try {
      await page.reload();
      await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
      await geomRow(page, gid).click({ button: 'right' });
      await expect(page.locator('[data-geom-menu]')).toHaveCount(0);
      await expect(page.locator('[data-geometry-action-button="demo"]')).toHaveCount(0);
      const off = await request.post(`${host.base}/api/geometry-actions/open`, { data: { project_id: pid, geometry_id: gid, plugin: 'edit-demo', study_kind: 'demo' } });
      expect((await off.json()).code).toBe('plugin_off');
    } finally {
      expect((await request.post(`${host.base}/api/plugins/edit-demo/enable`)).ok()).toBe(true);
    }
  });

  test('a click opens the study "box"; a second tab opens the same one; the page reads the part, its faces and the launch face @plugins', async ({ page, context, request }) => {
    test.setTimeout(240_000);
    const pid = await newProject(request, host, 'Actions open');
    const gid = await importFile(request, host, pid, 'box.step');
    const sim = await apiStudy(request, host, pid, gid);
    const top = faceAlong(host, pid, gid, 1);
    await apiBc(request, host, pid, sim.id, 'Inlet', [top.label]);
    await openProject(page, host, pid);
    const frame = await editFromTree(page, pid, gid);
    await expect(frame.locator('#title')).toHaveText('box');
    const sid = await studyOf(page);
    const ctx = JSON.parse(await frame.locator('#ctx').textContent());
    expect(ctx).toEqual({ id: gid, name: 'box', format: 'step', fileName: 'box.step', linked: false, rev: 0, bodies: 1, faces: 6 });
    await expect(frame.locator('#launch')).toHaveText('null');
    // The STEP and the face table.
    await frame.locator('#read-source').click();
    await expect(frame.locator('#src')).toContainText('"adopted":false', { timeout: 30_000 });
    const src = JSON.parse(await frame.locator('#src').textContent());
    expect([src.sha256, src.hashed, src.name, src.format]).toEqual([BOX_SHA, BOX_SHA, 'box.step', 'step']);
    await frame.locator('#faces').click();
    await expect(frame.locator('#face-list')).toContainText('"faces":6', { timeout: 30_000 });
    const faces = JSON.parse(await frame.locator('#face-list').textContent());
    expect(faces.sourceSha256).toBe(BOX_SHA);
    expect(faces.uses).toEqual([{ index: Number(top.label.match(/\d+/)[0]), label: top.label, normal: [0, 0, 1], uses: ['bc:Inlet'] }]);
    // A second tab opens the same study.
    const page2 = await context.newPage();
    await openProject(page2, host, pid);
    await editFromTree(page2, pid, gid);
    expect(await studyOf(page2)).toBe(sid);
    await page2.close();
    const studies = (await getJson(request, `${host.base}/api/plugin-studies?project_id=${pid}`)).studies.filter((s) => s.plugin === 'edit-demo');
    expect(studies.map((s) => s.title)).toEqual(['box']);
    // Back with no change: the geometry's row says the Part is editing it; STUDIES does not list it.
    await back(page, pid);
    await expect(page.locator(`#left-tree [data-w16-geom="${gid}"] [data-geom-edited-by="${sid}"]`)).toContainText('Being edited in box', { timeout: 30_000 });
    await expect(page.locator(`[data-plugin-study="${sid}"]`)).toHaveCount(0);
    // The viewport's right-click passes the face; a reload has none.
    const at = await partPoint(page);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.locator('#face-ctx-menu [data-geom-action="demo"]').click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}/ws/edit-demo/demo/${sid}$`));
    const frame2 = page.frameLocator('#workspace-frame');
    await expect(frame2.locator('#launch')).toHaveText(JSON.stringify({ face: `face ${at.faceId}@Body${at.solidId || 1}`, body: `Body${at.solidId || 1}` }), { timeout: 30_000 });
    await page.reload();
    await expect(page.frameLocator('#workspace-frame').locator('#title')).toHaveText('box', { timeout: 60_000 });
    await expect(page.frameLocator('#workspace-frame').locator('#launch')).toHaveText('null');
    expect(JSON.parse(await page.frameLocator('#workspace-frame').locator('#ctx').textContent()).id).toBe(gid);
  });

  test('two bodies: the viewport right-click on the second body passes that body and its face, as the face table names it @plugins', async ({ page, request }) => {
    test.setTimeout(180_000);
    const pid = await newProject(request, host, 'Actions two bodies');
    const gid = await importFile(request, host, pid, TWO_BODIES);
    await openProject(page, host, pid);
    const at = await partPoint(page, 2);
    expect(at.solidId).toBe(2);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.locator('#face-ctx-menu [data-geom-action="demo"]').click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}/ws/edit-demo/demo/st-[0-9a-f]+$`));
    const frame = page.frameLocator('#workspace-frame');
    const launch = { face: `face ${at.faceId}@Body2`, body: 'Body2' };
    await expect(frame.locator('#launch')).toHaveText(JSON.stringify(launch), { timeout: 30_000 });
    expect(JSON.parse(await frame.locator('#ctx').textContent())).toMatchObject({ id: gid, bodies: 2 });
    // The page finds that face in the host's face table, on that body.
    const row = await frame.locator('body').evaluate(
      (el, label) => window.__ws.project.geometryFaces().then((t) => {
        const f = t.faces.find((x) => x.label === label);
        return f ? { label: f.label, body: f.body } : null;
      }),
      launch.face,
    );
    expect(row).toEqual({ label: launch.face, body: 2 });
  });

  test('Edit v2 overwrites box in place: same id, BCs follow by name, mesh out of date, original kept, after a reload too @plugins', async ({ page, request }) => {
    test.setTimeout(300_000);
    const pid = await newProject(request, host, 'Actions adopt');
    const gid = await importFile(request, host, pid, 'box.step');
    const sim = await apiStudy(request, host, pid, gid);
    const top = faceAlong(host, pid, gid, 1);
    const bottom = faceAlong(host, pid, gid, -1);
    const inlet = await apiBc(request, host, pid, sim.id, 'Inlet', [top.label]);
    const wall = await apiBc(request, host, pid, sim.id, 'Wall', [bottom.label]);
    await generatedMesh(request, host, pid, sim.id);
    await openProject(page, host, pid);
    const frame = await editFromTree(page, pid, gid);
    await frame.locator('#edit-v2').click();
    const q = await answerQuestion(page, 'overwrite');
    expect([q.heading, q.overwrite]).toEqual(['box has a new shape', 'Overwrite box']);
    await expect(frame.locator('#status')).toHaveText('shape rev 1', { timeout: 180_000 });
    const result = JSON.parse(await frame.locator('#result').textContent());
    expect(result).toMatchObject({ geometryId: gid, change: 'shape', rev: 1, fromRev: 0, created: false, lost: 0 });
    // The host's report: where the original went, and the mesh must be generated again.
    const report = await readReport(page);
    expect(report.copy).toContain('box updated from box. The original file is kept: Geometry panel → Add the original as a new geometry.');
    expect(`${report.title} ${report.copy}`).toContain('Mesh 1');
    await back(page, pid);
    const check = async () => {
      // The row: "from box" (the Demo study), its Edit button.
      await expect(geomRow(page, gid).locator('[data-geom-from]')).toHaveText('from box', { timeout: 60_000 });
      const newTop = faceAlong(host, pid, gid, 1);
      expect(newTop.z).toBeCloseTo(30, 6);
      expect(await bcFaces(request, host, pid, sim.id, inlet)).toEqual({ faces: [newTop.label], lost: 0 });
      expect(await bcFaces(request, host, pid, sim.id, wall)).toEqual({ faces: [faceAlong(host, pid, gid, -1).label], lost: 0 });
      await expect(page.locator(`#left-tree [data-w16-geom="${gid}"] [data-mesh-out-of-date]`).first()).toHaveText('Out of date', { timeout: 30_000 });
      const kept = join(geomDir(host, pid, gid), 'link', 'original', 'source.step');
      expect(sha256(readFileSync(kept))).toBe(BOX_SHA);
      // The panel shows the original.
      await geomRow(page, gid).locator('.tl').click();
      await expect(page.locator('[data-geometry-original="1"]')).toContainText('box.step', { timeout: 30_000 });
    };
    await check();
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    await check();
    // "Add as new geometry": the original beside it.
    await page.locator('[data-geometry-original-import="1"]').click();
    await expect.poll(async () => (await getJson(request, `${host.base}/api/project/tree?project_id=${pid}`)).geometries.map((g) => g.name).sort(), { timeout: 60_000 }).toEqual(['box', 'box (original)']);
    // The action opens the same study again (the one that links it now).
    const again = await request.post(`${host.base}/api/geometry-actions/open`, { data: { project_id: pid, geometry_id: gid, plugin: 'edit-demo', study_kind: 'demo' } });
    expect((await again.json()).created).toBe(false);
    // A save drawn on the plain box (no stamp of rev 1) is refused now.
    const stale = await request.post(`${host.base}/api/bcs`, { data: { project_id: pid, simulation_id: sim.id, id: wall, name: 'Wall', bc_type: 'Wall', faces: ['face 1@Body1'], geometry_rev: 0 } });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).code).toBe('geometry_changed');
  });

  test("without the original's names the top's BC is lost; Keep editing changes nothing; Save as new adds box v2 @plugins", async ({ page, request }) => {
    test.setTimeout(300_000);
    // Without names.
    const pid = await newProject(request, host, 'Actions plain');
    const gid = await importFile(request, host, pid, 'box.step');
    const sim = await apiStudy(request, host, pid, gid);
    const inlet = await apiBc(request, host, pid, sim.id, 'Inlet', [faceAlong(host, pid, gid, 1).label]);
    await openProject(page, host, pid);
    let frame = await editFromTree(page, pid, gid);
    await frame.locator('#edit-v2-plain').click();
    await answerQuestion(page, 'overwrite');
    await expect(frame.locator('#status')).toHaveText('shape rev 1', { timeout: 180_000 });
    // The host's report names the BC whose face is lost.
    expect((await readReport(page)).copy).toContain('Inlet');
    expect(await bcFaces(request, host, pid, sim.id, inlet)).toEqual({ faces: [], lost: 1 });
    // Keep editing, then Save as new (another project).
    const pid2 = await newProject(request, host, 'Actions save as new');
    const gid2 = await importFile(request, host, pid2, 'box.step');
    const sim2 = await apiStudy(request, host, pid2, gid2);
    const bc2 = await apiBc(request, host, pid2, sim2.id, 'Inlet', [faceAlong(host, pid2, gid2, 1).label]);
    await openProject(page, host, pid2);
    frame = await editFromTree(page, pid2, gid2);
    await frame.locator('#edit-v2').click();
    await answerQuestion(page, 'cancel');
    await expect(frame.locator('#status')).toContainText('cancelled', { timeout: 60_000 });
    expect(readdirSync(join(geomDir(host, pid2, gid2)))).toContain('source.step');
    expect(await bcFaces(request, host, pid2, sim2.id, bc2)).toEqual({ faces: [faceAlong(host, pid2, gid2, 1).label], lost: 0 });
    await frame.locator('#edit-v2').click();
    await answerQuestion(page, 'new');
    await expect(frame.locator('#status')).toHaveText('shape rev 1', { timeout: 180_000 });
    expect((await readReport(page)).title).toBe('box v2 added');
    const made = JSON.parse(await frame.locator('#result').textContent());
    expect(made.created).toBe(true);
    expect(made.geometryId).not.toBe(gid2);
    const tree = (await getJson(request, `${host.base}/api/project/tree?project_id=${pid2}`)).geometries;
    expect(tree.map((g) => g.name).sort()).toEqual(['box', 'box v2']);
    const plain = tree.find((g) => g.id === gid2);
    expect([plain.rev, plain.source, plain.format]).toEqual([undefined, undefined, 'step']);
    expect(plain.studies.map((s) => s.id)).toEqual([sim2.id]);
    expect(await bcFaces(request, host, pid2, sim2.id, bc2)).toEqual({ faces: [faceAlong(host, pid2, gid2, 1).label], lost: 0 });
  });

  test('refusals: a bad originalNames, a second editor, a removed geometry @plugins', async ({ page, request }) => {
    test.setTimeout(240_000);
    const pid = await newProject(request, host, 'Actions refusals');
    const gid = await importFile(request, host, pid, 'box.step');
    await openProject(page, host, pid);
    const frame = await editFromTree(page, pid, gid);
    const sid = await studyOf(page);
    const bad = await frame.locator('body').evaluate(() => window.editV2({ names: 'bad' }).then(() => 'linked', (e) => `${e.code}: ${e.message}`));
    expect(bad).toMatch(/^bad_face_names: originalNames does not describe box: /);
    // Every row naming another face: refused before anything happens.
    const rotated = await frame.locator('body').evaluate(() => window.editV2({ names: 'rotated' }).then(() => 'linked', (e) => `${e.code}: ${e.message}`));
    expect(rotated).toBe("bad_face_names: originalNames: 6 of 6 faces don't match box");
    // A second editor of the same kind (made by hand: the action opens the first one).
    const other = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'edit-demo', kind: 'demo', title: 'Other' } });
    const oid = (await other.json()).study.id;
    const f = join(host.projects, pid, 'plugins', 'edit-demo', 'studies', oid, 'study.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), edits_geometry: { id: gid, name: 'box', at: 'x' } }));
    const first = await frame.locator('body').evaluate(() => window.editV2().then((r) => `${r.change} ${r.adopted} ${r.unverified}`, (e) => e.code));
    expect(first).toBe('shape true 0');
    // Nothing used the geometry, so no question; the app still says what happened, plainly.
    await expect(page.locator('[data-ws-toast]')).toContainText('box updated from box. The original file is kept: Geometry panel → Add the original as a new geometry.', { timeout: 30_000 });
    await page.evaluate((h) => (location.hash = h), `#/p/${pid}/ws/edit-demo/demo/${oid}`);
    const frameB = page.frameLocator('#workspace-frame');
    await expect(frameB.locator('#title')).toHaveText('Other', { timeout: 30_000 });
    expect(await frameB.locator('#ctx').textContent()).toBe('null');
    const late = await frameB.locator('body').evaluate(() => window.editV2().then(() => 'linked', (e) => `${e.code}: ${e.message}`));
    expect(late).toBe('adopted: box is already edited in box.');
    expect(sid).not.toBe(oid);
    // A geometry removed before the first link: the host asks; "Add as new geometry" makes a new one.
    const pid2 = await newProject(request, host, 'Actions removed early');
    const gid2 = await importFile(request, host, pid2, 'box.step');
    const opened = await (await request.post(`${host.base}/api/geometry-actions/open`, { data: { project_id: pid2, geometry_id: gid2, plugin: 'edit-demo', study_kind: 'demo' } })).json();
    const rm = await request.post(`${host.base}/api/geometry/remove`, { data: { project_id: pid2, geometry_id: gid2 } });
    expect(rm.ok(), await rm.text()).toBe(true);
    await openProject(page, host, pid2);
    await page.evaluate((h) => (location.hash = h), `#/p/${pid2}/ws/edit-demo/demo/${opened.study_id}`);
    const frameC = page.frameLocator('#workspace-frame');
    await expect(frameC.locator('#title')).toHaveText('box', { timeout: 30_000 });
    expect(await frameC.locator('#ctx').textContent()).toBe('null');
    const pending = frameC.locator('body').evaluate(() => window.editV2().then((r) => r, (e) => ({ error: e.code })));
    const asked = await answerQuestion(page, 'new');
    expect([asked.heading, asked.copy, asked.newLabel, asked.overwrite]).toEqual(['box was removed from the project', 'Add box as a new geometry?', 'Add as new geometry', 'Not now']);
    const made = await pending;
    expect(made).toMatchObject({ created: true, change: 'shape', rev: 1 });
    expect(made.geometryId).not.toBe(gid2);
  });

  test('a removed box: its Part stays in STUDIES and asks before it adds it again; a new box of the same name is never taken over @plugins', async ({ page, request }) => {
    test.setTimeout(420_000);
    const pid = await newProject(request, host, 'Actions removed target');
    const gid = await importFile(request, host, pid, 'box.step');
    const geometries = async () => (await getJson(request, `${host.base}/api/project/tree?project_id=${pid}`)).geometries;
    await openProject(page, host, pid);
    let frame = await editFromTree(page, pid, gid);
    const sid = await studyOf(page);
    // 1. Edit, change: the Part takes box over (nothing uses it: no question). Back.
    await frame.locator('#edit-v2').click();
    await expect(frame.locator('#status')).toHaveText('shape rev 1', { timeout: 180_000 });
    await back(page, pid);
    await expect(geomRow(page, gid).locator('[data-geom-from]')).toHaveText('from box', { timeout: 30_000 });
    // 2. Remove box from the Geometry panel: the question says the Part stays.
    // Its name (the row's middle is the link's "Edit").
    await geomRow(page, gid).locator('.tl').first().click();
    await page.locator('#panel-geometry .mat-clear-link', { hasText: 'Delete' }).click({ timeout: 30_000 });
    await expect(page.locator('#modal-confirm')).toBeVisible();
    await expect(page.locator('#cf-copy')).toHaveText(
      "The CAD is removed from this project. The Demo editor edit demo 'box' that edits it stays. It won't add the geometry back unless you choose to.",
    );
    await page.screenshot({ path: test.info().outputPath('1-remove-question.png') });
    await page.locator('#cf-confirm').click();
    await expect.poll(async () => (await geometries()).length, { timeout: 30_000 }).toBe(0);
    // The Part stays, in STUDIES, and says why it is not in the simulation.
    await expect(page.locator(`[data-plugin-study="${sid}"] [data-plugin-study-removed="${gid}"]`)).toHaveText('Its geometry box was removed', { timeout: 30_000 });
    // 3. The same file again: a new box. Its row is not the Part's, and its action makes a new study.
    const gid2 = await importFile(request, host, pid, 'box.step');
    expect(gid2).not.toBe(gid);
    // The import went by the route: load the project again.
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    await expect(page.locator(`#left-tree [data-w16-geom="${gid2}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`#left-tree [data-w16-geom="${gid2}"] [data-geom-edited-by]`)).toHaveCount(0);
    await expect(page.locator(`[data-plugin-study="${sid}"] [data-plugin-study-removed="${gid}"]`)).toBeVisible();
    const fresh = await (await request.post(`${host.base}/api/geometry-actions/open`, { data: { project_id: pid, geometry_id: gid2, plugin: 'edit-demo', study_kind: 'demo' } })).json();
    expect(fresh.study_id).not.toBe(sid);
    // 4. Reopen the Part from STUDIES: it edits no geometry now. A change asks; Not now adds nothing.
    await page.locator(`[data-plugin-study="${sid}"] > .tree-row`).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}/ws/edit-demo/demo/${sid}$`));
    frame = page.frameLocator('#workspace-frame');
    await expect(frame.locator('#title')).toHaveText('box', { timeout: 30_000 });
    expect(await frame.locator('#ctx').textContent()).toBe('null');
    await frame.locator('#edit-v2').click();
    const asked = await answerQuestion(page, 'not_now');
    expect([asked.heading, asked.copy, asked.newLabel, asked.overwrite]).toEqual(['box was removed from the project', 'Add box as a new geometry?', 'Add as new geometry', 'Not now']);
    await expect(frame.locator('#status')).toContainText('Refused: not_now', { timeout: 60_000 });
    expect((await geometries()).map((g) => g.id)).toEqual([gid2]);
    await back(page, pid);
    await expect(page.locator(`[data-plugin-study="${sid}"] [data-plugin-study-removed="${gid}"]`)).toBeVisible({ timeout: 30_000 });
    // 5. Again: it asks again; Add as new geometry adds "box v2" (box is the new one's name).
    await page.locator(`[data-plugin-study="${sid}"] > .tree-row`).click();
    frame = page.frameLocator('#workspace-frame');
    await expect(frame.locator('#title')).toHaveText('box', { timeout: 30_000 });
    await frame.locator('#edit-v2').click();
    expect((await answerQuestion(page, 'new')).heading).toBe('box was removed from the project');
    await expect(frame.locator('#status')).toHaveText('shape rev 1', { timeout: 180_000 });
    const made = JSON.parse(await frame.locator('#result').textContent());
    expect(made.created).toBe(true);
    expect([made.geometryId === gid, made.geometryId === gid2]).toEqual([false, false]);
    const tree = await geometries();
    expect(tree.map((g) => g.name).sort()).toEqual(['box', 'box v2']);
    // The new box: untouched, a plain import with no link.
    const plain = tree.find((g) => g.id === gid2);
    expect([plain.name, plain.rev, plain.source]).toEqual(['box', undefined, undefined]);
    expect(readdirSync(geomDir(host, pid, gid2))).toContain('source.step');
    const rec = JSON.parse(readFileSync(join(host.projects, pid, 'plugins', 'edit-demo', 'studies', sid, 'study.json'), 'utf8'));
    expect(rec.geometry_removed).toBeUndefined();
    await back(page, pid);
    await expect(page.locator(`[data-plugin-study="${sid}"] [data-plugin-study-geometry="${made.geometryId}"]`)).toHaveText('\u2192 box v2', { timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath('2-added-again.png') });
  });
});

test.describe('geometry actions: a crash in the adoption (host API 1.7)', () => {
  test('a host whose every apply fails leaves box fenced; after a restart the recovery finishes the adoption @plugins', async ({ request }) => {
    test.setTimeout(360_000);
    const tmp = e2eTemp('geometry-actions-crash');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    const bundledDir = bundledIfOnly(tmp);
    const pluginsDir = join(tmp, 'plugins');
    cpSync(resolve('python/tests/fixtures/edit-plugins'), pluginsDir, { recursive: true });
    const boot = (env, port = 0) => startHost({ name: 'geometry-actions-crash', tmp, projects, pluginsDir, bundledDir, seed: false, env, ...(port ? { port } : {}) });
    let host = await boot({ MAGNUSIM_TEST_LINK_FAIL_APPLY: '1' });
    try {
      const pid = await newProject(request, host, 'Actions crash');
      const gid = await importFile(request, host, pid, 'box.step');
      const sid = (await (await request.post(`${host.base}/api/geometry-actions/open`, { data: { project_id: pid, geometry_id: gid, plugin: 'edit-demo', study_kind: 'demo' } })).json()).study_id;
      // The page's files, then the link route (as the bridge sends it).
      const put = (file, as) => {
        const rel = `studies/${sid}/exports/${as}`;
        const dest = join(projects, pid, 'plugins', 'edit-demo', rel);
        cpSync(join(FX, file), dest);
        return { rel, sha256: sha256(readFileSync(dest)) };
      };
      const shape = put('box-pulled.bbrep', 'shape.bbrep');
      const r = await request.post(`${host.base}/api/plugin-geometry/link`, {
        data: {
          project_id: pid,
          plugin: 'edit-demo',
          study_id: sid,
          shape: { ...shape, format: 'brep' },
          face_names: put('box-pulled.face_names.json', 'names.json'),
          original_names: put('box.original_names.json', 'original_names.json'),
          source_version: 1,
          based_on_rev: null,
        },
      });
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(202);
      await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: pid } });
      await expect
        .poll(async () => (await getJson(request, `${host.base}/api/plugin-geometry/status?project_id=${pid}&plugin=edit-demo&study_id=${sid}&job_id=${body.job_id}`)).job.status, { timeout: 120_000 })
        .toBe('failed');
      const dir = geomDir(host, pid, gid);
      expect(readdirSync(join(dir, 'link'))).toContain('commit.json');
      expect(readdirSync(join(dir, 'link', 'original'))).toContain('source.step');
      // A crash, not a stop (stop() also removes the server's temp root, projects and all).
      const port = host.port;
      killTree(host.pid);
      host = await boot({}, port);
      await expect
        .poll(async () => {
          // The server may still be reading the project right after its start: no tree yet.
          const doc = await getJson(request, `${host.base}/api/project/tree?project_id=${pid}`).catch(() => ({}));
          const node = ((doc && doc.geometries) || []).find((g) => g.id === gid);
          return node ? `${node.rev}-${!!node.updating}` : 'none';
        }, { timeout: 180_000, intervals: [500] })
        .toBe('1-false');
      expect(JSON.parse(readFileSync(join(dir, 'id.json'), 'utf8')).source.adopted).toBe(true);
      expect(sha256(readFileSync(join(dir, 'link', 'original', 'source.step')))).toBe(BOX_SHA);
    } finally {
      host?.stop();
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      } catch {
        /* the next run's temp root is its own */
      }
    }
  });
});
