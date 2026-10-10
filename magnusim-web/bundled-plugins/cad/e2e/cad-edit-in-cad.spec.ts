// Edit in CAD (host API 1.7). Daniel: "if I import a step file into the main section, I
// should be able to click on the geometry or right click the part itself and click like
// 'Edit in CAD' to open it up in the CAD stuff." The real host and the real kernel:
//   - cad:edit-flow (gate:l3-cad): the repository's stepped-bore STEP imported in the
//     simulation view, Inlet on the counterbore's flat bottom and Outlet on the top face,
//     a mesh generated; the tree row's right-click -> Edit in CAD opens a Part titled with
//     the geometry's name that imports it by itself; press-pull the top face +10 mm; Back ->
//     Overwrite: the same geometry, rev 1, Outlet on the face that moved up 10 mm, Inlet
//     where it was, no face lost, the mesh out of date, the original kept; Edit in CAD again
//     opens the same Part (Import, Press-pull) and Back with no change links nothing; a
//     fresh Edit in CAD and Back with no change leaves the geometry as it was too;
//   - cad:edit-ineligible: an STL geometry's Edit in CAD is shown disabled, with the reason;
//   - cad:edit-viewport: the viewport right-click on the part -> Edit in CAD; the Part
//     selects the face that was right-clicked;
//   - cad:edit-vortex: Daniel's Vortex (CAD_E2E_VORTEX_STEP): the faces matched (logged),
//     a BC on the moved face follows it, one on another face stays. Under the gate
//     (CAD_L3_REQUIRE=1) a missing Vortex fails.
// No numbers are typed by the test into the project: the BCs and the mesh go through the
// app's own routes, as in the link specs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerLinkQuestion, geometryRow, watchPage } from './helpers';
import {
  BOX,
  BOX_FACES,
  REQUIRE,
  STEPPED,
  type V3,
  VORTEX,
  type W,
  backButton,
  backUnchanged,
  bcsOf,
  cad,
  cadFaces,
  edit,
  editOpened,
  faceNo,
  generatedMesh,
  history,
  importGeometry,
  landed,
  landings,
  linkedOf,
  metaOf,
  near,
  newProject,
  oneFace,
  openProject,
  partOpened,
  pressPull,
  shot,
  simulationWithBcs,
  startEditHost,
  stopEditHost,
  timingsNote,
  treeMenuItem,
  up,
} from './edit-in-cad-helpers';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await startEditHost('cad-edit-in-cad', 40);
});
test.afterAll(() => stopEditHost());

test.describe('Edit in CAD', () => {
  test('cad:edit-flow a STEP in the simulation view: Edit in CAD from its row, press-pull the top, Back -> Overwrite: the same geometry at rev 1, Outlet moved with the top, Inlet where it was, nothing lost, mesh out of date, original kept; reopen; Back with no change links nothing', async ({ page, request }, info) => {
    test.setTimeout(900_000);
    const seen = await watchPage(page);
    const pid = await newProject(request, `CAD edit flow ${Date.now()}`);
    const geom = await importGeometry(request, pid, STEPPED, 'stepped-bore.step');
    const m0 = await metaOf(request, pid, geom.id);
    const top = oneFace(m0.faces, (f) => up(f) && near(f.centroid[2], 30, 1e-3), 'top face (z 30)');
    const ledge = oneFace(m0.faces, (f) => up(f) && near(f.centroid[2], 20, 1e-3), 'counterbore bottom (z 20)');
    const { simId, bcIds } = await simulationWithBcs(request, pid, geom.id, [
      { name: 'Inlet', type: 'Velocity inlet', face: ledge.id },
      { name: 'Outlet', type: 'Pressure outlet', face: top.id },
    ]);
    await generatedMesh(request, pid, simId);
    await openProject(page, pid);

    // Right-click the geometry's row: Edit in CAD, enabled, with its hint.
    const item = await treeMenuItem(page, geom.id);
    await expect(item).toContainText('Edit in CAD');
    await expect(item).toBeEnabled();
    await shot(page, 'edit-flow-menu');
    await item.click();
    // The Part is titled with the geometry's name and imports it by itself.
    await expect(page.locator('#workspace-overlay [data-ws-title]')).toHaveText(geom.name, { timeout: 60_000 });
    const { sid, frame } = await editOpened(page, pid);
    expect(await history(page)).toEqual(['import']);
    await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Imported 1 (stepped-bore.step)']);
    const e1 = await edit(page);
    expect(e1.adopt).toMatchObject({ geometryId: geom.id, matched: m0.faces.length, total: m0.faces.length });
    timingsNote(info, 'stepped-bore', e1.timings, { matched: e1.adopt!.matched, total: e1.adopt!.total });
    // Nothing changed in the project by opening it.
    expect(await linkedOf(request, pid, sid)).toBeNull();

    // Press-pull the top face +10 mm.
    const cf = await cadFaces(page);
    const cadTop = cf.filter((f) => f.normal && near(f.normal[2], 1, 1e-6) && near(f.centroid[2], 30, 1e-3));
    expect(cadTop).toHaveLength(1);
    await pressPull(page, frame, cadTop[0].i, 10);
    expect(await history(page)).toEqual(['import', 'press_pull']);
    await shot(page, 'edit-flow-pressed');

    // Back -> the app's question names the geometry -> Overwrite.
    const before = await landings(page);
    await backButton(page).click();
    await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 300_000 });
    await expect(page.locator('#lc-overwrite')).toContainText(`Overwrite ${geom.name}`);
    await shot(page, 'edit-flow-question');
    await answerLinkQuestion(page, 'overwrite');
    const report = await landed(page, pid, before);
    info.annotations.push({ type: 'report', description: JSON.stringify(report) });

    // The same geometry, at rev 1, adopted, the original kept.
    const ln = (await linkedOf(request, pid, sid))!;
    expect([ln.geometryId, ln.rev, ln.lostFaces]).toEqual([geom.id, 1, 0]);
    expect(ln.adopted).toBe(true);
    expect(ln.original?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(geometryRow(page, geom.id)).toBeVisible();
    const m1 = await metaOf(request, pid, geom.id);
    expect(m1.zmax).toBeCloseTo(40, 3);
    // Outlet on the face that moved +10 (z 40); Inlet still on the counterbore's bottom (z 20).
    const bcs = await bcsOf(request, pid, simId);
    const at = (bcId: string) => {
      const b = bcs.find((x) => x.id === bcId)!;
      expect(b.lost_faces ?? [], `${b.name} lost no face`).toEqual([]);
      expect(b.faces).toHaveLength(1);
      return m1.faces.find((f) => f.id === faceNo(b.faces[0]))!;
    };
    const outlet = at(bcIds.Outlet);
    const inlet = at(bcIds.Inlet);
    expect(up(outlet) && near(outlet.centroid[2], 40, 1e-3), `Outlet on the top at z 40: ${JSON.stringify(outlet)}`).toBe(true);
    expect(up(inlet) && near(inlet.centroid[2], 20, 1e-3) && near(inlet.area, ledge.area, 1e-3 * ledge.area), `Inlet on the counterbore bottom: ${JSON.stringify(inlet)}`).toBe(true);
    // The mesh made from the original is out of date (the report says so).
    expect([...report.lines, report.toast ?? ''].join('\n')).toMatch(/Out of date: Mesh 1/);
    expect([...report.lines, report.toast ?? ''].join('\n')).not.toMatch(/Lost/);

    // Edit in CAD again: the same Part, its history as left, no import again; Back with no change links nothing.
    await (await treeMenuItem(page, geom.id)).click();
    const again = await editOpened(page, pid);
    expect(again.sid).toBe(sid);
    expect(await history(page)).toEqual(['import', 'press_pull']);
    await backUnchanged(page, pid);
    expect((await linkedOf(request, pid, sid))!.rev).toBe(1);
    expect(seen.csp, 'CSP violations').toEqual([]);
  });

  test('cad:edit-unchanged the Geometry panel Edit in CAD button, then Back with no change: the geometry is left exactly as it was (nothing linked, no question)', async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, `CAD edit unchanged ${Date.now()}`);
    const geom = await importGeometry(request, pid, BOX, 'box20.step');
    await openProject(page, pid);
    // A click on the geometry's row opens its Geometry panel, with the button.
    await geometryRow(page, geom.id).click();
    const button = page.locator('[data-geometry-action-button="part"]');
    await expect(button).toBeVisible({ timeout: 30_000 });
    await expect(button).toBeEnabled();
    await expect(button).toContainText('Edit in CAD');
    await shot(page, 'edit-panel-button');
    await button.click();
    const { sid } = await editOpened(page, pid);
    await backUnchanged(page, pid);
    expect(await linkedOf(request, pid, sid)).toBeNull();
    const m = await metaOf(request, pid, geom.id);
    expect(m.nFaces).toBe(6);
  });

  test('cad:edit-ineligible an STL geometry: Edit in CAD is shown disabled, with the reason', async ({ page, request }, info) => {
    test.setTimeout(300_000);
    const dir = info.outputPath('stl');
    mkdirSync(dir, { recursive: true });
    const stl = join(dir, 'cube.stl');
    // A 10 mm cube, 12 triangles (ASCII STL).
    const v: V3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
    const tris = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    writeFileSync(stl, `solid cube\n${tris.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i].join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid cube\n`);
    const pid = await newProject(request, `CAD edit STL ${Date.now()}`);
    const geom = await importGeometry(request, pid, stl, 'cube.stl');
    await openProject(page, pid);
    const item = await treeMenuItem(page, geom.id);
    await expect(item).toBeDisabled();
    await expect(item).toContainText(`${geom.name} is a mesh (STL); Edit in CAD needs a STEP, IGES or BREP part.`);
    await shot(page, 'edit-ineligible');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-geom-menu]')).toHaveCount(0);
  });

  test('cad:edit-viewport the viewport right-click on the part -> Edit in CAD: the Part opens and selects the face that was right-clicked', async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, `CAD edit viewport ${Date.now()}`);
    const geom = await importGeometry(request, pid, BOX, 'box20.step');
    const m0 = await metaOf(request, pid, geom.id);
    await openProject(page, pid);
    await expect(geometryRow(page, geom.id)).toBeVisible({ timeout: 60_000 });
    // A point of the part on screen whose face is the same 8 px all round.
    let hit: { x: number; y: number; face: number } | null = null;
    await expect
      .poll(
        async () => {
          hit = await page.evaluate(() => {
            const canvas = document.querySelector('#viewer canvas');
            const pick = (window as unknown as { __CFD_PICK_CAD__?: (e: { clientX: number; clientY: number }) => { faceId?: number } | null }).__CFD_PICK_CAD__;
            if (!canvas || !pick) return null;
            const r = canvas.getBoundingClientRect();
            const at = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('#viewer') ? (pick({ clientX: x, clientY: y })?.faceId ?? 0) : 0);
            for (let fy = 0.35; fy <= 0.65; fy += 0.05)
              for (let fx = 0.35; fx <= 0.65; fx += 0.05) {
                const x = Math.round(r.left + r.width * fx);
                const y = Math.round(r.top + r.height * fy);
                const f = at(x, y);
                if (f && [[8, 0], [-8, 0], [0, 8], [0, -8]].every(([dx, dy]) => at(x + dx, y + dy) === f)) return { x, y, face: f };
              }
            return null;
          });
          return hit !== null;
        },
        { timeout: 60_000, message: 'a face of the part on screen' },
      )
      .toBe(true);
    if (!hit) throw new Error('no face on screen');
    const h = hit as { x: number; y: number; face: number };
    await page.mouse.click(h.x, h.y, { button: 'right' });
    await expect(page.locator('#face-ctx-menu')).toBeVisible();
    const act = page.locator('#face-ctx-menu [data-face-act="geometry-action"][data-geom-action="part"][data-geom-action-plugin="cad"]');
    await expect(act).toBeVisible();
    await expect(act).toContainText('Edit in CAD');
    await shot(page, 'edit-viewport-menu');
    await act.click();
    await editOpened(page, pid);
    const e = await edit(page);
    // The app gives the face and its body; the face is what the Part selects.
    expect(e.launched).toMatchObject({ face: `face ${h.face}@Body1`, selected: true });
    // The selected CAD face is where the right-clicked face is: its centroid and normal.
    const sel = await cad<{ kind: string; index: number }[]>(page, (() => (window as unknown as W).__CAD__.services.selection.get().items) as never);
    expect(sel).toHaveLength(1);
    expect(sel[0].kind).toBe('face');
    const cf = (await cadFaces(page)).find((f) => f.i === sel[0].index)!;
    const hf = m0.faces.find((f) => f.id === h.face)!;
    expect(cf.centroid.every((c, k) => near(c, hf.centroid[k], 1e-3)), `CAD face ${JSON.stringify(cf)} is host face ${JSON.stringify(hf)}`).toBe(true);
    await shot(page, 'edit-viewport-selected');
  });

  test('cad:edit-two-tabs Edit in CAD in two tabs at once: one Import is kept (the other tab Reloads and imports nothing more), then press-pull and Overwrite: every BC kept on its face (review B1)', async ({ page, context, request }) => {
    test.setTimeout(900_000);
    const pid = await newProject(request, `CAD edit two tabs ${Date.now()}`);
    const geom = await importGeometry(request, pid, STEPPED, 'stepped-bore.step');
    const m0 = await metaOf(request, pid, geom.id);
    const top = oneFace(m0.faces, (f) => up(f) && near(f.centroid[2], 30, 1e-3), 'top face (z 30)');
    const ledge = oneFace(m0.faces, (f) => up(f) && near(f.centroid[2], 20, 1e-3), 'counterbore bottom (z 20)');
    const { simId, bcIds } = await simulationWithBcs(request, pid, geom.id, [
      { name: 'Inlet', type: 'Velocity inlet', face: ledge.id },
      { name: 'Outlet', type: 'Pressure outlet', face: top.id },
    ]);
    const pageB = await context.newPage();
    await openProject(page, pid);
    await openProject(pageB, pid);
    const itemA = await treeMenuItem(page, geom.id);
    const itemB = await treeMenuItem(pageB, geom.id);
    await Promise.all([itemA.click(), itemB.click()]);
    // 'none' until the Part's frame is there (it opens a moment after the address changes).
    const phase = async (p: typeof page) => {
      try {
        return await cad<string>(p, (() => (window as unknown as W).__CAD__?.edit?.state.get().phase ?? 'none') as never);
      } catch {
        return 'none';
      }
    };
    const chipOf = (p: typeof page) => p.frameLocator('#workspace-frame').locator('[data-chip="save"]');
    // Each tab ends ready; a tab whose save met the other tab's shows Reload, and after it is ready too.
    for (const p of [page, pageB]) {
      await expect(p).toHaveURL(new RegExp(`#/p/${pid}/ws/cad/part/[^/]+$`), { timeout: 60_000 });
      await expect
        .poll(
          async () => {
            const reload = chipOf(p).locator('[data-chip-action="Reload"]');
            // A bounded click: the chip can go between the check and the click (this tab reloaded by
            // itself), and an unbounded click would then wait for it forever inside this poll.
            if (await reload.isVisible().catch(() => false)) await reload.click({ timeout: 5_000 }).catch(() => {});
            return phase(p);
          },
          { timeout: 300_000, intervals: [500] },
        )
        .toBe('ready');
    }
    expect(page.url()).toBe(pageB.url());
    const sid = decodeURIComponent(/\/ws\/cad\/part\/([^/]+)$/.exec(page.url())![1]);
    // One Import in each tab, the same one, and the record names it.
    const importsA = await cad<string[]>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.map((f: { id: string }) => f.id)) as never);
    const importsB = await cad<string[]>(pageB, (() => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.map((f: { id: string }) => f.id)) as never);
    expect(importsA).toHaveLength(1);
    expect(importsB).toEqual(importsA);
    const rec = await cad<{ importId: string; originalNames: { rel: string } | null }>(page, (async () => (window as unknown as W).__CAD__.edit.ready()) as never);
    expect(rec.importId).toBe(importsA[0]);
    expect(rec.originalNames?.rel).toBe(`studies/${sid}/adopt/${importsA[0]}/original_names.json`);
    await pageB.close();
    // Press-pull the top +10 in the first tab, Back, Overwrite.
    await expect(page.frameLocator('#workspace-frame').locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 60_000 });
    const frame = page.frameLocator('#workspace-frame');
    const cadTop = (await cadFaces(page)).filter((f) => f.normal && near(f.normal[2], 1, 1e-6) && near(f.centroid[2], 30, 1e-3));
    expect(cadTop).toHaveLength(1);
    await pressPull(page, frame, cadTop[0].i, 10);
    const before = await landings(page);
    await backButton(page).click();
    await answerLinkQuestion(page, 'overwrite');
    await landed(page, pid, before);
    const ln = (await linkedOf(request, pid, sid))!;
    expect([ln.geometryId, ln.rev, ln.lostFaces]).toEqual([geom.id, 1, 0]);
    const m1 = await metaOf(request, pid, geom.id);
    const bcs = await bcsOf(request, pid, simId);
    for (const [name, z] of [['Outlet', 40], ['Inlet', 20]] as const) {
      const b = bcs.find((x) => x.id === bcIds[name])!;
      expect(b.lost_faces ?? [], `${name} lost no face`).toEqual([]);
      const f = m1.faces.find((x) => x.id === faceNo(b.faces[0]))!;
      expect(up(f) && near(f.centroid[2], z, 1e-3), `${name} at z ${z}: ${JSON.stringify(f)}`).toBe(true);
    }
  });

  test('cad:edit-undo-to-import press-pull, then Undo back to the import, then Back: no question, nothing linked, the geometry as it was (review B2)', async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, `CAD edit undo ${Date.now()}`);
    const geom = await importGeometry(request, pid, STEPPED, 'stepped-bore.step');
    const m0 = await metaOf(request, pid, geom.id);
    const top = oneFace(m0.faces, (f) => up(f) && near(f.centroid[2], 30, 1e-3), 'top face (z 30)');
    const { simId, bcIds } = await simulationWithBcs(request, pid, geom.id, [{ name: 'Outlet', type: 'Pressure outlet', face: top.id }]);
    await openProject(page, pid);
    await (await treeMenuItem(page, geom.id)).click();
    const { sid, frame } = await editOpened(page, pid);
    const cadTop = (await cadFaces(page)).filter((f) => f.normal && near(f.normal[2], 1, 1e-6) && near(f.centroid[2], 30, 1e-3));
    await pressPull(page, frame, cadTop[0].i, 10);
    expect(await history(page)).toEqual(['import', 'press_pull']);
    await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
    await expect.poll(() => history(page)).toEqual(['import']);
    await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 60_000 });
    // The save counter moved on (a press-pull and its undo were saved), the design did not.
    await backUnchanged(page, pid);
    expect(await linkedOf(request, pid, sid)).toBeNull();
    const m1 = await metaOf(request, pid, geom.id);
    expect([m1.nFaces, m1.zmax]).toEqual([m0.nFaces, m0.zmax]);
    const bcs = await bcsOf(request, pid, simId);
    expect(bcs.find((b) => b.id === bcIds.Outlet)!.faces).toEqual([`face ${top.id}@Body1`]);
  });

  test('cad:edit-surface-only a surface-only STEP (box20-faces): its six faces are matched, no failure note (review S5)', async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, `CAD edit surfaces ${Date.now()}`);
    const geom = await importGeometry(request, pid, BOX_FACES, 'box20-faces.step');
    await openProject(page, pid);
    await (await treeMenuItem(page, geom.id)).click();
    await editOpened(page, pid);
    const e = await edit(page);
    expect(e.adopt).toMatchObject({ matched: 6, total: 6, error: null });
    await expect(page.frameLocator('#workspace-frame').locator('[data-edit-open]')).toBeHidden();
  });

  test('cad:edit-wait-stop while the app answers "not ready": the waiting line with Stop, modelling disabled with the reason; Stop says nothing was imported; Try again opens it (review S7)', async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, `CAD edit wait ${Date.now()}`);
    const geom = await importGeometry(request, pid, BOX, 'box20.step');
    await openProject(page, pid);
    // The app answers the source "not ready" (the geometry is updating) until the route is lifted.
    await page.route('**/api/plugin-geometry/source**', (route) =>
      route.fulfill({ status: 503, headers: { 'Retry-After': '1' }, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'not_ready', error: `${geom.name} is updating.`, retryAfter: 1 }) }),
    );
    await (await treeMenuItem(page, geom.id)).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}/ws/cad/part/[^/]+$`), { timeout: 60_000 });
    const frame = await partOpened(page);
    const line = frame.locator('[data-edit-open]');
    await expect(line).toHaveAttribute('data-edit-open', 'waiting', { timeout: 60_000 });
    await expect(line.locator('[data-edit-open-line]')).toHaveText(`Waiting for Magnusim to finish storing ${geom.name}`);
    await expect(line.locator('[data-edit-open-action="stop"]')).toHaveText('Stop');
    const sketch = frame.locator('[data-cad-toolbar] [data-command="sketch.new"]');
    await expect(sketch).toHaveAttribute('data-disabled-reason', `Opening ${geom.name} from the project`);
    await shot(page, 'edit-wait-stop');
    await line.locator('[data-edit-open-action="stop"]').click();
    await expect(line).toHaveAttribute('data-edit-open', 'error');
    await expect(line.locator('[data-edit-open-line]')).toHaveText(`Stopped opening ${geom.name}. Nothing was imported.`);
    expect(await history(page)).toEqual([]);
    await expect(sketch).not.toHaveAttribute('data-disabled-reason', `Opening ${geom.name} from the project`);
    await page.unroute('**/api/plugin-geometry/source**');
    await line.locator('[data-edit-open-action="retry"]').click();
    await expect.poll(() => cad<string>(page, (() => (window as unknown as W).__CAD__.edit.state.get().phase) as never), { timeout: 180_000 }).toBe('ready');
    expect(await history(page)).toEqual(['import']);
  });

  test('cad:edit-vortex Daniel\'s Vortex: Edit in CAD imports it by itself, matches its faces, and a BC on the moved face follows it while another stays', async ({ page, request }, info) => {
    test.setTimeout(1_200_000);
    if (!VORTEX || !existsSync(VORTEX)) {
      if (REQUIRE) throw new Error(`gate:l3-cad needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP (now "${VORTEX}")`);
      test.skip(true, 'CAD_E2E_VORTEX_STEP is not set (opt-in: Daniel\'s Vortex STEP)');
    }
    const pid = await newProject(request, `CAD edit vortex ${Date.now()}`);
    const t0 = Date.now();
    const geom = await importGeometry(request, pid, VORTEX, 'Vortex CFD Test.step');
    const m0 = await metaOf(request, pid, geom.id);
    const hostImport = Date.now() - t0;
    // The highest flat face looking up (it is moved), and the lowest looking down (it stays).
    const ups = m0.faces.filter(up).sort((a, b) => b.centroid[2] - a.centroid[2]);
    const downs = m0.faces.filter((f) => !!f.normal && near(f.normal[2], -1, 1e-6)).sort((a, b) => a.centroid[2] - b.centroid[2]);
    expect(ups.length && downs.length, 'a flat face up and one down').toBeTruthy();
    const moved = ups[0];
    const kept = downs[0];
    const { simId, bcIds } = await simulationWithBcs(request, pid, geom.id, [
      { name: 'Outlet', type: 'Pressure outlet', face: moved.id },
      { name: 'Floor', type: 'Wall', face: kept.id },
    ]);
    await openProject(page, pid);
    await (await treeMenuItem(page, geom.id)).click();
    const { sid, frame } = await editOpened(page, pid, 900_000);
    const e = await edit(page);
    timingsNote(info, 'vortex', { host_import: hostImport, ...e.timings }, { matched: e.adopt!.matched, total: e.adopt!.total });
    expect(e.adopt!.total).toBe(m0.faces.length);
    // Healing may change a face; most must match by index or fingerprint.
    expect(e.adopt!.matched / e.adopt!.total, `${e.adopt!.matched} of ${e.adopt!.total} faces matched`).toBeGreaterThan(0.9);
    const cf = await cadFaces(page);
    const cadMoved = cf.filter((f) => f.normal && near(f.normal[2], 1, 1e-6) && near(f.centroid[2], moved.centroid[2], 1e-3) && near(f.area, moved.area, 1e-3 * moved.area));
    expect(cadMoved).toHaveLength(1);
    await pressPull(page, frame, cadMoved[0].i, 2);
    const before = await landings(page);
    await backButton(page).click();
    await answerLinkQuestion(page, 'overwrite');
    await landed(page, pid, before);
    const ln = (await linkedOf(request, pid, sid))!;
    expect([ln.geometryId, ln.rev]).toEqual([geom.id, 1]);
    const m1 = await metaOf(request, pid, geom.id);
    const bcs = await bcsOf(request, pid, simId);
    const faceOf = (id: string) => m1.faces.find((f) => f.id === faceNo(bcs.find((b) => b.id === id)!.faces[0]))!;
    const out = faceOf(bcIds.Outlet);
    const floor = faceOf(bcIds.Floor);
    expect(up(out) && near(out.centroid[2], moved.centroid[2] + 2, 1e-3), `Outlet moved up 2 mm: ${JSON.stringify(out)}`).toBe(true);
    expect(near(floor.centroid[2], kept.centroid[2], 1e-3) && near(floor.area, kept.area, 1e-3 * kept.area), `Floor where it was: ${JSON.stringify(floor)}`).toBe(true);
  });
});
