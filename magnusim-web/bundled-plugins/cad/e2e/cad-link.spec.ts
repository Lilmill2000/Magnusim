// gate:l2-cad, a Part's design as a project geometry (host API 1.5, LINK L2), in
// the real host with the real kernel. The sync runs where leaving the workspace
// will run it (host API 1.6, L3): the link controller, reached here through
// window.__CAD__.link (the Part has no button for it: Daniel, the sync happens on
// exit). Each test:
//   - create: the first link adds "Part 1" to the project (its row "from Part 1",
//     the part in the viewport after Back); the exported BREP and face names pass
//     the app's own checker (python -m magnusim_sdk.link check); readable labels;
//     the study record's source_version is the design's;
//   - update in place: a changed design updates the same geometry (rev 2, the new
//     height), with no question while no simulation setup uses it, and no report
//     (nothing of a setup changed; host 253d6a4 reports only what the setup holds);
//   - no change: the same saved design exports nothing (no file written, no call),
//     also after the Part is reopened; and a re-export of the same design after a
//     reopen is byte-identical (the app answers "none": its hashes are equal);
//   - the app's question (a simulation study with a boundary condition on it):
//     Keep editing changes nothing; Overwrite updates in place; Save as new adds
//     "Part 1 v2", which the Part links from then on;
//   - stale: a second tab with an older design is refused, with the app's words;
//   - Include in simulation: the Bodies row's toggle and the body's menu; a body
//     left out is not sent; with none left the Part says so and links nothing;
//     Undo is one step;
//   - never a partial design (link review L1): a feature that fails to build
//     refuses the link with a plain message and changes nothing; suppressed, the
//     same saved design links (the no-change rule did not pin the refusal);
//   - names (the link review's names.spec, ported): an update keeps a boundary
//     condition on its faces by CAD's face names (match by name, nothing lost,
//     the labels kept), and the app's report names that record and its faces (by
//     CAD's labels) as moved far; a material on a renamed body; a hidden body is still
//     in the export; the header renames the linked Part while its page writes
//     the study record (no "Rename failed").
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  addSolid,
  answerLinkQuestion,
  baseUrl,
  countFileWrites,
  fileWrites,
  geometryRow,
  linkedGeometry,
  newPartFromTree,
  newProject,
  openPart,
  openProject,
  partOpened,
  pluginFile,
  readLinkQuestion,
  simulationOn,
  sourceVersion,
  syncLink,
  wallOn,
  watchPage,
  workspaceFrame,
  type LinkOutcomeJson,
} from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';
const PYTHON = process.env.CAD_E2E_PYTHON || resolve('../../python/.venv/Scripts/python.exe');

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const back = async (page: Page) => {
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
};
const partRow = (page: Page) => page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: 'Part 1' }) });
const toast = (page: Page) => page.locator('#workspace-overlay [data-ws-toast]');
const studyId = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { bridge: { studyId: string } } } }).__CAD__.services.bridge.studyId);

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, projectId };
}

/** The Bodies folder open (a click on its row toggles it). */
async function expandBodies(frame: FrameLocator) {
  const folder = frame.locator('[data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
}

/** Saved, with no rebuild running. */
async function settled(page: Page) {
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 30_000 });
  await expect
    .poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { status: string } } } } } } }).__CAD__.services.doc.state.get().rebuild.status))
    .toBe('done');
}

/** An extrude's blind distance, as its panel would set it. */
async function setHeight(page: Page, extrude: string, mm: number) {
  await workspaceFrame(page).evaluate(
    ({ id, d }) => {
      const doc = (window as unknown as { __CAD__: { services: { doc: { beginEdit(id: string): { update(p: unknown): void; commit(): void } } } } }).__CAD__.services.doc;
      const s = doc.beginEdit(id);
      s.update({ extent: { kind: 'blind', distance: `${d} mm` } });
      s.commit();
    },
    { id: extrude, d: mm },
  );
  await settled(page);
}

/** The app's checker on the Part's export: exit 0 and "ok", or the problems. */
function appCheck(dir: string, brep: Buffer, names: Buffer): { code: number; out: string } {
  mkdirSync(dir, { recursive: true });
  const shape = join(dir, 'part.bbrep');
  const sidecar = join(dir, 'face_names.json');
  writeFileSync(shape, brep);
  writeFileSync(sidecar, names);
  const r = spawnSync(PYTHON, ['-m', 'magnusim_sdk.link', 'check', shape, sidecar], { encoding: 'utf8', timeout: 120_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** The geometry's part as the app reads it (its preview's meta). */
async function partMeta(request: Parameters<typeof newProject>[0], pid: string, gid: string) {
  const r = await request.get(`${baseUrl()}/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=meta`);
  expect(r.ok()).toBe(true);
  const m = await r.json();
  return { zmax: Math.round(m.bounds.zmax), faces: m.n_faces as number };
}

/** The app's report after an update the page made (#modal-confirm): its title, then OK. */
async function okReport(page: Page): Promise<string> {
  const modal = page.locator('#modal-confirm');
  await expect(modal).toBeVisible({ timeout: 30_000 });
  const title = (await page.locator('#cf-heading').textContent()) ?? '';
  await page.locator('#cf-confirm').click();
  await expect(modal).toBeHidden();
  return title;
}

/** The first line of the app's update report when faces were kept by their names. */
const KEPT_BY_NAME = 'Boundary conditions, refinements and monitors kept their faces by name.';

type Report = { title: string; lines: string[] };

/** The app's report dialog (#modal-confirm, OK only) when one shows: its title and lines, then OK. */
async function takeReport(page: Page): Promise<Report | null> {
  const modal = page.locator('#modal-confirm');
  if (!(await modal.isVisible())) return null;
  const title = ((await page.locator('#cf-heading').textContent()) ?? '').trim();
  const lines = (await page.locator('#cf-copy').innerText())
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  expect(await page.locator('#cf-cancel').isVisible(), `"${title}" is a report (OK only)`).toBe(false);
  await page.locator('#cf-confirm').click();
  await expect(modal).toBeHidden();
  return { title, lines };
}

/**
 * No report: the update touched nothing of a setup (host 253d6a4: the report names only what the
 * setup holds), so no dialog shows, watched for 2.5 s.
 */
async function expectNoReport(page: Page) {
  const until = Date.now() + 2_500;
  while (Date.now() < until) {
    const r = await takeReport(page);
    expect(r, 'no report: nothing of a setup changed').toBeNull();
    await page.waitForTimeout(250);
  }
}

/**
 * A sync whose answer may wait on the app's question: answer `choice`, then its outcome and every
 * report the app showed on the way and for 2.5 s after (each OK'd, its words kept for the test).
 */
async function syncAnswering(page: Page, choice: 'new' | 'overwrite' | 'cancel'): Promise<{ out: LinkOutcomeJson; reports: Report[] }> {
  const p = syncLink(page);
  await answerLinkQuestion(page, choice);
  let out: LinkOutcomeJson | null = null;
  void p.then((r) => (out = r));
  const reports: Report[] = [];
  await expect
    .poll(
      async () => {
        const r = await takeReport(page);
        if (r) reports.push(r);
        return out ? 'done' : 'waiting';
      },
      { timeout: 180_000, intervals: [250] },
    )
    .toBe('done');
  // A report can show a moment after the call resolved.
  const until = Date.now() + 2_500;
  while (Date.now() < until) {
    const r = await takeReport(page);
    if (r) reports.push(r);
    await page.waitForTimeout(250);
  }
  return { out: out!, reports };
}

test.describe('gate:l2-cad linking a Part', () => {
  // Under the gate (CAD_LINK_REQUIRE_PYTHON=1) a missing Python fails every test here; never a skip.
  test.beforeEach(() => {
    if (process.env.CAD_LINK_REQUIRE_PYTHON === '1' && !existsSync(PYTHON)) throw new Error(`gate:l2-cad needs the app's Python for magnusim_sdk.link check: set CAD_E2E_PYTHON (looked for ${PYTHON})`);
  });
  test.skip(process.env.CAD_LINK_REQUIRE_PYTHON !== '1' && !existsSync(PYTHON), `needs the app's Python for magnusim_sdk.link check: set CAD_E2E_PYTHON (looked for ${PYTHON})`);

  test('cad:link-create the first link adds "Part 1" to the project; its files pass the app checker; its row and the part after Back', async ({ page, request }, testInfo) => {
    test.setTimeout(300_000);
    const { seen, frame, projectId } = await freshPart(page, request);
    await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    expect(await linkedGeometry(page)).toBeNull();
    const v = await sourceVersion(page);
    const r = await syncLink(page);
    expect(r.outcome, JSON.stringify(r)).toBe('linked');
    expect(r.result).toMatchObject({ created: true, name: 'Part 1', rev: 1, bodies: 1, faces: 6, named: 6 });
    const gid = r.result!.geometryId;
    const linked = (await linkedGeometry(page))!;
    expect([linked.geometryId, linked.rev, linked.sourceVersion]).toEqual([gid, 1, v]);

    // The export: what the app reads, checked by the app's own code.
    const sid = await studyId(page);
    const brep = (await pluginFile(page, `studies/${sid}/export/part.bbrep`))!;
    const names = (await pluginFile(page, `studies/${sid}/export/face_names.json`))!;
    expect(brep.subarray(0, 64).toString('latin1')).toContain('Open CASCADE Topology V4');
    const check = appCheck(testInfo.outputPath('export'), brep, names);
    expect(check.out).toBe('ok');
    expect(check.code).toBe(0);
    const sidecar = JSON.parse(names.toString('utf8')) as { bodies: { index: number; name: string; label: string; id: string; color: string }[]; faces: { index: number; body: number; name: string; label: string }[]; shape_sha256: string };
    expect(sidecar.bodies).toEqual([{ index: 1, id: expect.stringMatching(/^b_/), name: 'Body 1', label: 'Body 1', color: '#bdc9db' }]);
    expect(sidecar.faces.map((f) => f.label).sort()).toEqual(['Extrude 1 · End', 'Extrude 1 · Side 1', 'Extrude 1 · Side 2', 'Extrude 1 · Side 3', 'Extrude 1 · Side 4', 'Extrude 1 · Start']);
    expect(sidecar.faces.every((f) => f.name.startsWith('F:') && !/#\d+$/.test(f.name))).toBe(true);
    expect(sidecar.shape_sha256).toBe(linked.shapeSha256);
    // Linked: a save from now on goes into the study record too (source_version), so the
    // geometry's row can say the design is newer than what it was made from.
    await workspaceFrame(page).evaluate(() => {
      const doc = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { bodies: { id: string }[] } } }; renameBody(id: string, n: string): unknown } } } }).__CAD__.services.doc;
      doc.renameBody(doc.state.get().rebuild.bodies[0].id, 'Housing');
    });
    await settled(page);
    expect(await sourceVersion(page)).toBe(v + 1);
    await expect
      .poll(() => workspaceFrame(page).evaluate(async () => Number((await (window as unknown as { __CAD__: { services: { bridge: { study: { get(): Promise<{ source_version?: number }> } } } } }).__CAD__.services.bridge.study.get()).source_version)))
      .toBe(v + 1);

    // The saved design (Body 1 renamed) is newer than the linked one: the app reads so from the
    // record (its project tree says `behind`, the row's "Not up to date with Part 1.").
    await expect
      .poll(async () => {
        const t = await (await request.get(`${baseUrl()}/api/project/tree?project_id=${projectId}`)).json();
        return ((t.geometries || []) as { id?: string; behind?: boolean }[]).find((g) => g.id === gid)?.behind ?? null;
      })
      .toBe(true);

    // Back: the exit hook (host API 1.6) brings the geometry up to date (the new body name), and
    // the project has the Part as a geometry, linked to it, shown in the viewport, up to date.
    await back(page);
    await expect(geometryRow(page, gid).locator('.tl').first()).toHaveText('Part 1', { timeout: 60_000 });
    await expect(geometryRow(page, gid).locator('[data-geom-from]')).toHaveText('from Part 1');
    await expect
      .poll(async () => (await (await request.get(`${baseUrl()}/api/plugin-geometry/linked?project_id=${projectId}&plugin=cad&study_id=${sid}`)).json()).linked?.sourceVersion, { timeout: 60_000 })
      .toBe(v + 1);
    await expect(geometryRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __CFD_W16__?: { geometry?: { id?: string } } }).__CFD_W16__?.geometry?.id ?? null), { timeout: 60_000 }).toBe(gid);
    expect((await partMeta(request, projectId, gid)).zmax).toBe(20);
    await shot(page, 'link-create-project-row');
    void frame;
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:link-update-and-skip an update changes the same geometry in place; the same saved design exports nothing, also after a reopen; a re-export after a reopen is byte-identical', async ({ page, request }) => {
    test.setTimeout(360_000);
    const { seen, projectId } = await freshPart(page, request);
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    const first = await syncLink(page);
    expect(first.outcome).toBe('linked');
    const gid = first.result!.geometryId;

    // Update in place: 20 -> 30 mm. No simulation setup uses it, so the app asks nothing.
    await setHeight(page, made.extrude, 30);
    const up = await syncLink(page);
    expect(up.outcome, JSON.stringify(up)).toBe('linked');
    expect(up.result).toMatchObject({ geometryId: gid, created: false, change: 'shape', rev: 2, fromRev: 1 });
    // No setup holds a face of it: the app reports nothing (no dialog).
    await expectNoReport(page);
    expect((await partMeta(request, projectId, gid)).zmax).toBe(30);
    await expect(page.locator('#modal-link-choice')).toBeHidden();

    // No change: nothing exported, nothing written, no call.
    await countFileWrites(page);
    const skip = await syncLink(page);
    expect(skip).toEqual({ outcome: 'unchanged', sourceVersion: await sourceVersion(page), geometryId: gid });
    expect(await fileWrites(page)).toEqual([]);

    // Reopened: still nothing to do.
    await back(page);
    let frame = await openPart(page, partRow(page));
    await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    await settled(page);
    await countFileWrites(page);
    expect((await syncLink(page)).outcome).toBe('unchanged');
    expect(await fileWrites(page)).toEqual([]);
    const before = (await linkedGeometry(page))!;

    // The same design saved again (the body left out, then back in: two saves, same design):
    // the reopened Part exports it again, byte for byte, so the app finds no change.
    await expandBodies(frame);
    const toggle = frame.locator('[data-body-row] [data-body-act="simulation"]');
    await toggle.click();
    await settled(page);
    await toggle.click();
    await settled(page);
    expect(await sourceVersion(page)).toBe(before.sourceVersion + 2);
    const again = await syncLink(page);
    expect(again.outcome, JSON.stringify(again)).toBe('linked');
    expect(again.result).toMatchObject({ geometryId: gid, change: 'none', rev: 2 });
    const after = (await linkedGeometry(page))!;
    expect([after.shapeSha256, after.namesSha256, after.rev]).toEqual([before.shapeSha256, before.namesSha256, 2]);
    frame = page.frameLocator('#workspace-frame');
    void frame;
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test("cad:link-question the app's question: Keep editing changes nothing; Overwrite updates in place; Save as new adds Part 1 v2, linked from then on", async ({ page, request }) => {
    test.setTimeout(480_000);
    const { seen, projectId } = await freshPart(page, request);
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    const first = await syncLink(page);
    expect(first.outcome).toBe('linked');
    const gid = first.result!.geometryId;
    // A simulation study with a wall on the part: setup the app protects.
    const sim = await simulationOn(request, projectId, gid);
    await wallOn(request, projectId, sim.id, ['face 1@Body1'], 1);

    await setHeight(page, made.extrude, 25);
    let p = syncLink(page);
    const q = await readLinkQuestion(page);
    expect([q.title, q.overwrite, q.overwriteDisabled, q.newLabel, q.cancel]).toEqual(['Part 1 has a new shape', 'Overwrite Part 1', false, 'Save as new geometry', 'Keep editing']);
    expect(q.copy).toBe(`Part 1 is used by ${sim.name}. How should the simulation get the new shape?`);
    await shot(page, 'link-question');
    const errorsBefore = seen.errors.length;
    await answerLinkQuestion(page, 'cancel');
    expect(await p).toEqual({ outcome: 'kept-editing', sourceVersion: await sourceVersion(page) });
    // The Part's call got the refusal and handled it: nothing uncaught in the app's page (the
    // host logged an uncaught BridgeError here before cb62201), and no other error.
    await page.waitForTimeout(1_000);
    expect(seen.errors.slice(errorsBefore), 'no page or console error after Keep editing').toEqual([]);
    await expect(toast(page)).toHaveCount(0);
    expect((await linkedGeometry(page))!.rev).toBe(1);
    expect((await partMeta(request, projectId, gid)).zmax).toBe(20);

    // Overwrite: the same geometry, rev 2, the new height. The wall's face did not move far: no report.
    const { out: ow, reports: owReports } = await syncAnswering(page, 'overwrite');
    expect(ow.outcome, JSON.stringify(ow)).toBe('linked');
    expect(ow.result).toMatchObject({ geometryId: gid, created: false, change: 'shape', rev: 2 });
    expect(owReports).toEqual([]);
    expect((await partMeta(request, projectId, gid)).zmax).toBe(25);

    // Save as new: "Part 1 v2"; the Part links it from now on; "Part 1" stays as it was.
    await setHeight(page, made.extrude, 35);
    p = syncLink(page);
    await answerLinkQuestion(page, 'new');
    const sn = await p;
    expect(sn.outcome, JSON.stringify(sn)).toBe('linked');
    expect(sn.result).toMatchObject({ created: true, name: 'Part 1 v2', rev: 1 });
    const gid2 = sn.result!.geometryId;
    expect(gid2).not.toBe(gid);
    expect((await linkedGeometry(page))!.geometryId).toBe(gid2);
    expect((await partMeta(request, projectId, gid2)).zmax).toBe(35);
    expect((await partMeta(request, projectId, gid)).zmax).toBe(25);
    // The app's report about the new geometry (always: it says what was added), then the next
    // sync with no change does nothing.
    expect(await okReport(page)).toBe('Part 1 v2 added');
    await expectNoReport(page);
    expect((await syncLink(page)).outcome).toBe('unchanged');

    await back(page);
    await expect(geometryRow(page, gid2).locator('.tl').first()).toHaveText('Part 1 v2', { timeout: 60_000 });
    await expect(geometryRow(page, gid2).locator('[data-geom-from]')).toHaveText('from Part 1');
    await expect(geometryRow(page, gid).locator('.tl').first()).toHaveText('Part 1');
    await expect(geometryRow(page, gid).locator('[data-geom-from]')).toHaveCount(0);
    await shot(page, 'link-saved-as-new');
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:link-stale a second tab with an older design and no change of its own reads the newer one in place: nothing is written over it, nothing asks (L3 review B1)', async ({ page, context, request }) => {
    test.setTimeout(300_000);
    const { projectId } = await freshPart(page, request);
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    expect((await syncLink(page)).outcome).toBe('linked');
    const url = page.url();
    // Tab B opens the same Part: the same design.
    const b = await context.newPage();
    await b.goto(url);
    const bf = await partOpened(b);
    await expect(bf.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    // Tab A changes the design and links it.
    await setHeight(page, made.extrude, 26);
    const a2 = await syncLink(page);
    expect(a2.outcome).toBe('linked');
    await expectNoReport(page);
    const linked = (await linkedGeometry(page))!;
    // Tab B, with the older design and no change of its own, links: it reads A's design in place
    // first (it had nothing to keep), finds the geometry has it, and does nothing; no refusal.
    expect(await sourceVersion(b)).toBeLessThan(linked.sourceVersion);
    await countFileWrites(b);
    const rb = await syncLink(b);
    expect(rb).toMatchObject({ outcome: 'unchanged', sourceVersion: linked.sourceVersion, geometryId: linked.geometryId });
    expect(await sourceVersion(b)).toBe(linked.sourceVersion);
    await expect(bf.locator('[data-chip="save"]')).toHaveText('Saved');
    await expect(b.locator('#workspace-overlay [data-ws-toast]')).toHaveCount(0);
    // Nothing was exported or written over tab A's files.
    expect(await fileWrites(b)).toEqual([]);
    const still = (await linkedGeometry(page))!;
    expect([still.rev, still.sourceVersion, still.shapeSha256]).toEqual([linked.rev, linked.sourceVersion, linked.shapeSha256]);
    expect((await partMeta(request, projectId, still.geometryId)).zmax).toBe(26);
    await b.close();
  });

  test('cad:link-include the Bodies toggle and the body menu leave a body out of the simulation; none left: nothing is linked, and it says so', async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, frame } = await freshPart(page, request);
    const one = await addSolid(page, { size: [20, 20, 20] });
    const two = await addSolid(page, { at: [40, 0, 0], size: [20, 20, 10] });
    await settled(page);
    await expandBodies(frame);
    const row = (id: string) => frame.locator(`[data-body-row="${id}"]`);
    const toggle = (id: string) => row(id).locator('[data-body-act="simulation"]');
    // On by default, for every solid body.
    await expect(row(one.body!)).toHaveAttribute('data-in-simulation', '1');
    await expect(toggle(two.body!)).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(two.body!)).toHaveAttribute('aria-label', 'Leave Body 2 out of the simulation');
    // Body 2 left out, from its row.
    const v0 = await sourceVersion(page);
    await toggle(two.body!).click();
    await expect(row(two.body!)).toHaveAttribute('data-in-simulation', '0');
    await expect(toggle(two.body!)).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle(two.body!)).toHaveAttribute('aria-label', 'Include Body 2 in the simulation');
    await settled(page);
    expect(await sourceVersion(page)).toBe(v0 + 1);
    await shot(page, 'link-include-toggle');
    const r = await syncLink(page);
    expect(r.outcome).toBe('linked');
    expect(r.result).toMatchObject({ bodies: 1, faces: 6 });
    const sid = await studyId(page);
    const sidecar = JSON.parse((await pluginFile(page, `studies/${sid}/export/face_names.json`))!.toString('utf8')) as { bodies: { name: string; id: string }[] };
    expect(sidecar.bodies.map((x) => [x.name, x.id])).toEqual([['Body 1', one.body]]);
    // Body 2 back in, from its menu; Body 1 out, from its menu: one undo step each.
    await row(two.body!).locator('> .tree-row').click({ button: 'right' });
    await frame.locator('[data-cad-menu] [data-menu-item="body-simulation"]').filter({ hasText: 'Include Body 2 in the simulation' }).click();
    await expect(row(two.body!)).toHaveAttribute('data-in-simulation', '1');
    await row(one.body!).locator('> .tree-row').click({ button: 'right' });
    await frame.locator('[data-cad-menu] [data-menu-item="body-simulation"]').filter({ hasText: 'Leave Body 1 out of the simulation' }).click();
    await expect(row(one.body!)).toHaveAttribute('data-in-simulation', '0');
    // Both out: nothing to link, and the Part says so; the geometry keeps its last update.
    await toggle(two.body!).click();
    await settled(page);
    const none = await syncLink(page);
    expect(none).toEqual({ outcome: 'nothing', message: 'No body is included in the simulation; Part 1 keeps its last update.', empty: false, linked: true });
    await expect(toast(page)).toContainText('No body is included in the simulation; Part 1 keeps its last update.');
    expect((await linkedGeometry(page))!.rev).toBe(1);
    // Undo is one step: it brings Body 2 back in, and Body 1 stays out.
    await page.keyboard.press('Control+z');
    await expect(row(two.body!)).toHaveAttribute('data-in-simulation', '1');
    await expect(row(one.body!)).toHaveAttribute('data-in-simulation', '0');
    await settled(page);
    expect(await workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { state: { get(): { doc: { bodies: Record<string, { simulation?: boolean }> } } } } } } }).__CAD__.services.doc.state.get().doc.bodies)).toMatchObject({ [one.body!]: { simulation: false } });
    expect((await workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { state: { get(): { doc: { bodies: Record<string, { simulation?: boolean }> } } } } } } }).__CAD__.services.doc.state.get().doc.bodies))[two.body!].simulation).not.toBe(false);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });
  test('cad:link-not-built a feature that fails to build refuses the link, says why, and changes nothing; suppressed, the same saved design links', async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, frame, projectId } = await freshPart(page, request);
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    const first = await syncLink(page);
    expect(first.outcome).toBe('linked');
    const gid = first.result!.geometryId;
    // A Split by the Right plane 500 mm off: it cuts nothing, so it fails (red in the tree).
    const split = await workspaceFrame(page).evaluate((body) => {
      const doc = (window as unknown as { __CAD__: { services: { doc: { beginNew(t: string, init: unknown): { feature: string; commit(): void } } } } }).__CAD__.services.doc;
      const s = doc.beginNew('split', { targets: [body], tool: { kind: 'plane', plane: 'origin:right', offset: '500 mm' } });
      s.commit();
      return s.feature;
    }, made.body!);
    await settled(page);
    await expect(frame.locator(`[data-cad-tree] [data-feature-row][data-feature-type="split"]`)).toHaveAttribute('data-state', 'error');
    await countFileWrites(page);
    const refused = await syncLink(page);
    expect(refused).toEqual({ outcome: 'failed', code: 'not_built', message: 'Split 1 failed to build, so Part 1 keeps its last update. Fix, retry or suppress it first.', brief: 'Split 1 failed to build. Fix, retry or suppress it first.' });
    await expect(toast(page)).toContainText('Split 1 failed to build, so Part 1 keeps its last update. Fix, retry or suppress it first.');
    // Nothing written, the geometry as it was.
    expect(await fileWrites(page)).toEqual([]);
    expect((await linkedGeometry(page))!.rev).toBe(1);
    // A second try with the same saved design is still refused (the no-change rule never pins it).
    expect((await syncLink(page)).code).toBe('not_built');
    // Suppressed: the design builds whole, and it links.
    await workspaceFrame(page).evaluate((id) => (window as unknown as { __CAD__: { services: { doc: { setSuppressed(id: string, s: boolean): unknown } } } }).__CAD__.services.doc.setSuppressed(id, true), split);
    await settled(page);
    const ok = await syncLink(page);
    expect(ok.outcome, JSON.stringify(ok)).toBe('linked');
    expect(ok.result).toMatchObject({ geometryId: gid });
    expect((await partMeta(request, projectId, gid)).zmax).toBe(20);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:link-names an update keeps a boundary condition on its faces by name and a material on a renamed body; a hidden body is still in the export', async ({ page, request }) => {
    test.setTimeout(400_000);
    const { seen, frame, projectId } = await freshPart(page, request);
    const made = await addSolid(page, { size: [40, 30, 20] });
    const other = await addSolid(page, { at: [60, 0, 0], size: [10, 10, 10] });
    await settled(page);
    // Body 2 hidden: a view of the part, still in the simulation.
    await workspaceFrame(page).evaluate((id) => (window as unknown as { __CAD__: { services: { doc: { setBodyVisible(id: string, v: boolean): unknown } } } }).__CAD__.services.doc.setBodyVisible(id, false), other.body!);
    await expandBodies(frame);
    await expect(frame.locator(`[data-body-row="${other.body}"]`)).toHaveAttribute('data-visible', '0');
    await settled(page);
    const first = await syncLink(page);
    expect(first.outcome, JSON.stringify(first)).toBe('linked');
    expect(first.result).toMatchObject({ bodies: 2, faces: 12 });
    const gid = first.result!.geometryId;
    const sid = await studyId(page);
    type Sidecar = { bodies: { index: number; id: string; name: string }[]; faces: { index: number; body: number; label: string }[] };
    const sidecar = async () => JSON.parse((await pluginFile(page, `studies/${sid}/export/face_names.json`))!.toString('utf8')) as Sidecar;
    const sc1 = await sidecar();
    // The hidden body is in the export.
    expect(sc1.bodies.map((b) => [b.index, b.id, b.name])).toEqual([
      [1, made.body, 'Body 1'],
      [2, other.body, 'Body 2'],
    ]);
    const faceOf = (sc: Sidecar, label: string) => sc.faces.find((f) => f.body === 1 && f.label === label)!.index;
    const end1 = faceOf(sc1, 'Extrude 1 · End');
    const side1 = faceOf(sc1, 'Extrude 1 · Side 2');
    // A boundary condition on two of Body 1's faces, a material on Body 1.
    const sim = await simulationOn(request, projectId, gid);
    const bc = await request.post(`${baseUrl()}/api/bcs`, { data: { project_id: projectId, simulation_id: sim.id, name: 'Top', bc_type: 'Wall', faces: [`face ${end1}@Body1`, `face ${side1}@Body1`], geometry_rev: 1 } });
    expect(bc.ok(), await bc.text()).toBe(true);
    const bcId = (await bc.json()).bc.id as string;
    const mat = await request.post(`${baseUrl()}/api/materials`, { data: { project_id: projectId, simulation_id: sim.id, name: 'Air', assigned_volumes: ['Body1'], geometry_rev: 1 } });
    expect(mat.ok(), await mat.text()).toBe(true);
    const matId = (await mat.json()).material?.id as string | undefined;

    // Body 1 renamed and taller; then Overwrite.
    await workspaceFrame(page).evaluate((id) => (window as unknown as { __CAD__: { services: { doc: { renameBody(id: string, n: string): unknown } } } }).__CAD__.services.doc.renameBody(id, 'Housing'), made.body!);
    await settled(page);
    await setHeight(page, made.extrude, 33);
    const { out, reports } = await syncAnswering(page, 'overwrite');
    expect(out.outcome, JSON.stringify(out)).toBe('linked');
    // The app's report names the record and its two faces, by CAD's labels: both kept by name, both
    // moved far (the top 13 mm up, the side 65 % larger), so "Check them".
    expect(reports).toEqual([
      {
        title: 'Part 1 updated',
        lines: [KEPT_BY_NAME, `Kept by name but moved far: ${sim.name} › Top ('Extrude 1 · End'), ${sim.name} › Top ('Extrude 1 · Side 2'). Check them.`],
      },
    ]);
    const res = out.result as unknown as { geometryId: string; match: { byName: number }; lost: unknown[]; stillLost: number };
    expect(res.geometryId).toBe(gid);
    // Every face of the part found again by its name; nothing lost.
    expect(res.match.byName).toBeGreaterThanOrEqual(12);
    expect(res.lost).toEqual([]);
    expect(res.stillLost).toBe(0);

    const sc2 = await sidecar();
    expect(sc2.bodies.map((b) => [b.index, b.id, b.name])).toEqual([
      [1, made.body, 'Housing'],
      [2, other.body, 'Body 2'],
    ]);
    // The boundary condition is on the same faces, by their labels.
    const bcs = (await (await request.get(`${baseUrl()}/api/bcs?project_id=${projectId}&simulation_id=${sim.id}`)).json()).boundary_conditions as { id: string; faces: string[]; lost_faces?: unknown[] }[];
    const top = bcs.find((b) => b.id === bcId)!;
    const labelOf = (f: string) => sc2.faces.find((x) => x.index === Number(/face (\d+)@/.exec(f)![1]))?.label;
    expect(top.faces.map(labelOf).sort()).toEqual(['Extrude 1 · End', 'Extrude 1 · Side 2']);
    expect(top.lost_faces ?? []).toEqual([]);
    // The material is still on the renamed body (the app's Body1 is Housing now).
    const mats = (await (await request.get(`${baseUrl()}/api/materials?project_id=${projectId}&simulation_id=${sim.id}`)).json()) as { materials: { id: string; name: string; assigned_volumes: string[]; lost_faces?: unknown[] }[] };
    const air = mats.materials.find((m) => (matId ? m.id === matId : m.name === 'Air'))!;
    expect(air.assigned_volumes).toEqual(['Body1']);
    expect(air.lost_faces ?? []).toEqual([]);
    expect(sc2.bodies.find((b) => b.index === 1)!.name).toBe('Housing');

    // The header renames the linked Part while its page writes the study record (a save's
    // source_version moves the record's rev after the name was asked for): the rename goes
    // through, with no "Rename failed" (host fix cb62201), and the record keeps the page's write.
    const record = async () =>
      (await (await request.get(`${baseUrl()}/api/plugin-studies/get?${new URLSearchParams({ project_id: projectId, plugin: 'cad', study_id: sid })}`)).json()).study as { rev: number; title: string; source_version?: number };
    // The report was OK'd above: nothing covers the header.
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await page.locator('#workspace-overlay [data-ws-title]').click();
    await expect(page.locator('#pm-input')).toHaveValue('Part 1');
    const asked = await record();
    await setHeight(page, made.extrude, 36);
    await settled(page);
    const saved = await sourceVersion(page);
    await expect.poll(async () => (await record()).source_version, { timeout: 15_000 }).toBe(saved);
    expect((await record()).rev).toBeGreaterThan(asked.rev);
    await page.locator('#pm-input').fill('Gearbox');
    await page.locator('#pm-confirm').click();
    await expect(page.locator('#workspace-overlay [data-ws-title]')).toHaveText('Gearbox');
    await expect(page.locator('#modal-confirm')).toBeHidden();
    const renamed = await record();
    expect([renamed.title, renamed.source_version]).toEqual(['Gearbox', saved]);
    await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved');
    expect(seen.csp, 'CSP violations').toEqual([]);
    // The header's first rename was sent with the rev it showed and refused (409); the browser
    // logs that refusal as a failed resource load. Exactly that one line: the app then read the
    // record again and renamed (the stale-rev path ran), and nothing else was logged.
    const refusedRename = (e: string) => /status of 409 \(Conflict\) \(https?:\/\/[^/]+\/api\/plugin-studies\/rename\)$/.test(e);
    expect(seen.errors.filter(refusedRename), 'the first rename was refused once').toHaveLength(1);
    expect(seen.errors.filter((e) => !refusedRename(e)), 'console errors').toEqual([]);
  });
});
