// gate:l3-cad, exit sync (host API 1.6, L3): leaving the Part workspace brings the
// project's geometry up to date and lands in the simulation viewport with the
// part, looking the way the Part did. The real host and the real kernel; the
// Part's exit hook (src/link/leave.ts) does the sync, never a test call:
//   - first exit: Back creates "Part 1" (the export passes the app's checker) and
//     lands in the main viewport showing it, with the Part's camera (perspective,
//     vertical 30 degrees); the header's progress while the export is written;
//   - edit, exit: the app's question inside the leave (a Wall on a named face uses
//     the part): Keep editing stays in the Part with nothing changed; Overwrite
//     updates the same geometry in place and the Wall is still on that face; Save
//     as new lands on "Part 1 v2";
//   - exit with no change: no export, no link, nothing drawn in the header, a quick
//     landing; an orthographic camera carries over (its full height);
//   - a refused link (a feature that fails to build): the app's "Couldn't update
//     the project" with CAD's words; Stay keeps the Part; Leave anyway leaves it as
//     it was;
//   - Continue in background on a slow update (the compute slot held by the app's
//     test hook MAGNUSIM_TEST_SLOT_HOLD): the project shows the update queued, then
//     the new part, with the Part's camera (the view goes on linkGeometry: the page
//     closes before its hook returns, so only that view lands);
//   - the update's report: none when nothing of the setup changed, a toast for a mesh
//     left out of date, a dialog naming the record and the face when a face a record
//     holds moved far;
//   - browser Back, another project and Home sync too;
//   - typed text not applied: the saved design is linked, then the app's usual
//     question about the typed text (Stay keeps it; Leave discards it);
//   - Daniel's Vortex (CAD_E2E_VORTEX_STEP) with the Include toggle: a block left out
//     is not sent; with nothing included the leave says so in the header and goes on;
//   - fixes of the L3 reviews (SCR link3/fix1.md): a clean second tab another tab saved
//     over is not dirty and leaves without asking (B1); an old Part with removed
//     features says what to do, and Suppress them is one undoable step (B2); a save on
//     its way, a stuck one (CAD's own words at 25 s) and a refused one; nothing
//     included says so in the header only (no page toast);
//   - after a leave that linked nothing (Leave anyway on a refused link, nothing
//     included), the row says the Part is newer at once, with no tick and no reload.
// Landings are strict (awaitLanding): a report dialog is accepted only where the setup
// needs one (by its title, and its lines when the test gives them), any other dialog
// fails the test, and no dialog is ever clicked through on the way. The app's own record
// of the landing must say the same: a dialog, a toast (with its words) or nothing.
// This spec runs its own app server (startHost) with the slot-hold test hook, on its
// own Vite cache. Under the gate (CAD_L3_REQUIRE=1) a missing Python or Vortex fails.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appPythonMissing, findAppPython } from '../scripts/app-python.mjs';
// @ts-expect-error the app's host helper is plain JavaScript (e2e/host-server.d.mts types CAD's wrapper only)
import { startHost } from '../../../e2e/support/host-server.mjs';
import { addSolid, answerLeave, answerLinkQuestion, geometryRow, holdCommits, newPartFromTree, partOpened, readLinkQuestion, watchPage, workspaceFrame } from './helpers';

type Host = { base: string; projects: string; stop(): void; log(): string };
let host: Host | null = null;

const SHOTS = process.env.CAD_E2E_SHOTS || '';
// The app's Python (scripts/app-python.mjs: MAGNUSIM_PYTHON, the app's venv, or a python on PATH
// that imports cfddesk and magnusim_sdk, as in CI).
const FOUND = findAppPython();
const PYTHON = FOUND.python ?? '';
const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';
const REQUIRE = process.env.CAD_L3_REQUIRE === '1';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  host = (await startHost({
    name: 'cad-link-exit',
    // An empty projects root, not the app's own e2e projects: the tests make theirs, and Home (the
    // other-exits test) then lists only those, whose thumbnails CAD's links render. The app's
    // e2e projects' thumbnails answered 500 on Linux CI (their render, the app's, not CAD's).
    seed: false,
    enablePlugins: ['cad'],
    viteCacheDir: resolve('.cache', 'host-vite-link-exit'),
    portFrom: Number(process.env.CAD_E2E_PORT_FROM || 8170) + 30,
    env: { MAGNUSIM_E2E_WSL: null, MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_TEST_SLOT_HOLD: '1' },
    timeoutMs: 240_000,
  })) as Host;
});
test.afterAll(() => host?.stop());

const base = () => host!.base;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), timeout: 15_000 }).catch(() => {});
}

async function newProject(request: APIRequestContext, title: string): Promise<string> {
  const r = await request.post(`${base()}/api/project`, { data: { title, category: 'Other', units: 'Metric' } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return String(j.id);
}

async function deleteProject(request: APIRequestContext, pid: string) {
  await request.post(`${base()}/api/project/delete`, { data: { project_id: pid } }).catch(() => {});
}

async function openProject(page: Page, pid: string) {
  await page.goto(`${base()}/#/p/${pid}`);
  await page.waitForFunction((id) => (window as unknown as { __CFD_PROJECT_READY__?: string }).__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
}

/** The exit hook is registered (the Part connected to a 1.6 host). */
async function hookOn(page: Page) {
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__?: { leave?: { hook: string } } }).__CAD__?.leave?.hook ?? 'none'), { timeout: 30_000 }).toBe('on');
}

/** A new project with "Part 1" made from STUDIES, open in its workspace. */
async function freshPart(page: Page, request: APIRequestContext, title: string) {
  const seen = await watchPage(page);
  const pid = await newProject(request, title);
  await openProject(page, pid);
  const row = await newPartFromTree(page, 'Part 1');
  const sid = String(await row.getAttribute('data-plugin-study'));
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await hookOn(page);
  return { seen, pid, sid, frame };
}

const partRow = (page: Page) => page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: 'Part 1' }) });

/**
 * Open a Part again from its row (Part 1 by default). No dialog may be open (a late report
 * is judged by landingDialog, never OK'd in passing), and none may come up with the Part.
 */
async function reopen(page: Page, title = 'Part 1'): Promise<FrameLocator> {
  await landingDialog(page, null);
  const row = page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: title }) });
  await row.locator('> .tree-row').click();
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await hookOn(page);
  await settled(page);
  await landingDialog(page, null);
  return frame;
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

/** setHeight, without waiting for the save (a test that holds or refuses it). */
async function setHeightNoWait(page: Page, extrude: string, mm: number) {
  await workspaceFrame(page).evaluate(
    ({ id, d }) => {
      const doc = (window as unknown as { __CAD__: { services: { doc: { beginEdit(id: string): { update(p: unknown): void; commit(): void } } } } }).__CAD__.services.doc;
      const s = doc.beginEdit(id);
      s.update({ extent: { kind: 'blind', distance: `${d} mm` } });
      s.commit();
    },
    { id: extrude, d: mm },
  );
}

type Linked = { geometryId: string; name: string; rev: number; sourceVersion: number } | null;
async function linkedOf(request: APIRequestContext, pid: string, sid: string): Promise<Linked> {
  const r = await request.get(`${base()}/api/plugin-geometry/linked?project_id=${pid}&plugin=cad&study_id=${sid}`);
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).linked ?? null;
}

/** The geometry's part as the app reads it (its preview's meta). */
async function partMeta(request: APIRequestContext, pid: string, gid: string) {
  const r = await request.get(`${base()}/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=meta`);
  expect(r.ok()).toBe(true);
  const m = await r.json();
  return { zmax: Math.round(m.bounds.zmax), faces: m.n_faces as number };
}

/** The Part's export as written into the project (CAD's folder). */
function exportFile(pid: string, sid: string, name: 'part.bbrep' | 'face_names.json') {
  return join(host!.projects, pid, 'plugins', 'cad', 'studies', sid, 'export', name);
}
type Sidecar = { bodies: { index: number; id: string; name: string }[]; faces: { index: number; body: number; label: string }[] };
const sidecarOf = (pid: string, sid: string) => JSON.parse(readFileSync(exportFile(pid, sid, 'face_names.json'), 'utf8')) as Sidecar;

const landings = (page: Page) => page.evaluate(() => (window as unknown as { __CFD_LANDINGS__?: number }).__CFD_LANDINGS__ || 0);
type Landing = { geometryId: string; reason: string | null; landed?: string; view?: boolean; cameraKept?: boolean; report?: 'dialog' | 'toast' | false };
const lastLanding = (page: Page) => page.evaluate(() => (window as unknown as { __CFD_LAST_LANDING__?: Landing }).__CFD_LAST_LANDING__ ?? null);

/** The first line of the app's update report when faces were kept by their names. */
const KEPT_BY_NAME = 'Boundary conditions, refinements and monitors kept their faces by name.';

type Shown = { title: string; lines: string[] };

/**
 * The app dialog over the project now, judged: none (null), or the report `want` names (its
 * title), OK'd, with its lines. Any other dialog (a report the setup does not need, "Couldn't
 * update the project", "Leave without saving?") throws with its words: nothing is ever clicked
 * through by accident.
 */
async function landingDialog(page: Page, want: string | null): Promise<Shown | null> {
  const modal = page.locator('#modal-confirm');
  if (!(await modal.isVisible())) return null;
  const title = ((await page.locator('#cf-heading').textContent()) ?? '').trim();
  const lines = (await page.locator('#cf-copy').innerText())
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const okButton = page.locator('#cf-confirm');
  const okLabel = ((await okButton.textContent()) ?? '').trim();
  const cancelShown = await page.locator('#cf-cancel').isVisible();
  const report = okLabel === 'OK' && !cancelShown;
  if (!(want !== null && report && title === want))
    throw new Error(`an unexpected dialog over the project (not clicked): "${title}" ${JSON.stringify(lines)} [${okLabel}${cancelShown ? ' / ' + ((await page.locator('#cf-cancel').textContent()) ?? '').trim() : ''}]`);
  await okButton.click();
  await expect(modal).toBeHidden();
  return { title, lines };
}

/** The app's quiet words on its updates (its toasts), oldest first. */
const linkToasts = (page: Page) => page.evaluate(() => (window as unknown as { __CFD_LINK_TOASTS__?: string[] }).__CFD_LINK_TOASTS__ ?? []);

/**
 * Wait for the next landing. Dialogs on the way and for LATE_REPORT_MS after it are judged by
 * landingDialog: only `report` (a title, e.g. "Part 1 v2 added") when the setup needs one, which
 * must then come, with exactly `lines` when given; otherwise none. The app's record of the landing
 * must agree: 'dialog' for that report, 'toast' with exactly `toast`'s words (a mesh left out of
 * date), else nothing at all. Returns the reports seen.
 */
const LATE_REPORT_MS = 2_500;
async function awaitLanding(
  page: Page,
  before: number,
  { report = null, lines, toast = null }: { report?: string | null; lines?: string[]; toast?: string | null } = {},
): Promise<string[]> {
  const shown: Shown[] = [];
  const seen: string[] = [];
  const look = async () => {
    const s = await landingDialog(page, report);
    if (s) {
      shown.push(s);
      seen.push(s.title);
    }
  };
  await expect
    .poll(
      async () => {
        await look();
        return (await landings(page)) > before ? 'done' : 'waiting';
      },
      { timeout: 180_000, intervals: [250] },
    )
    .toBe('done');
  // A report comes a moment after the landing (findings.log: 0.2 to 0.6 s).
  const until = Date.now() + (report && !seen.length ? 15_000 : LATE_REPORT_MS);
  while (Date.now() < until && !(report && seen.length)) {
    await look();
    await page.waitForTimeout(250);
  }
  if (report) expect(seen, `the app's report "${report}" after the landing`).toEqual([report]);
  else expect(seen, 'no report dialog: nothing of the setup changed').toEqual([]);
  if (report && lines) expect(shown[0].lines, `the lines of "${report}"`).toEqual(lines);
  const last = await lastLanding(page);
  expect(last?.report ?? false, 'how the app reported the update').toBe(report ? 'dialog' : toast ? 'toast' : false);
  if (toast) expect((await linkToasts(page)).at(-1), "the app's toast").toBe(toast);
  return seen;
}

const backButton = (page: Page) => page.locator('#workspace-overlay [data-ws-back]');

/** The header's Back, the workspace closes, and the landing. */
async function backAndLand(page: Page, pid: string): Promise<string[]> {
  const before = await landings(page);
  await backButton(page).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
  return awaitLanding(page, before);
}

/** What the project's viewport shows: the geometry, its drawn cells and the stage. */
const viewport = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __CFD_W16__?: { geometry?: { id?: string }; fingerprint?: { nCells?: number } }; __CFD_WB_STAGE__?: string };
    return { id: w.__CFD_W16__?.geometry?.id ?? null, cells: w.__CFD_W16__?.fingerprint?.nCells ?? 0, stage: w.__CFD_WB_STAGE__ ?? '' };
  });

type CadCamera = { position: number[]; target: number[]; up: number[]; orthoHeight: number; projection: 'perspective' | 'orthographic' };
type HostCamera = { pos: number[]; fp: number[]; vu: number[]; parallel: boolean; scale: number | null; angle: number | null };

const cadCamera = (page: Page) =>
  workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { camera(): unknown } } } } } }).__CAD__.services.viewport.get().handle.camera() as CadCamera);

/** Put the Part's camera somewhere no framing would put it. */
async function setCadCamera(page: Page, c: CadCamera) {
  await workspaceFrame(page).evaluate((cam) => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { setCamera(c: unknown): void; setProjection(p: string): void } } } } } }).__CAD__.services.viewport.get().handle.setCamera(cam), c);
  return cadCamera(page);
}

const hostCamera = (page: Page) => page.evaluate(() => (window as unknown as { __CFD_CAMERA__(): unknown }).__CFD_CAMERA__() as HostCamera);
const near = (a: number[], b: number[], tol = 1e-3) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol * Math.max(1, Math.abs(b[i])));

/** The project's viewport looks the way the Part did: the same eye, target and up; perspective 30 degrees, or the same orthographic height. */
async function expectSameView(page: Page, cad: CadCamera) {
  const ok = (h: HostCamera | null) =>
    !!h &&
    near(h.pos, cad.position) &&
    near(h.fp, cad.target) &&
    near(h.vu, cad.up, 1e-3) &&
    h.parallel === (cad.projection === 'orthographic') &&
    (cad.projection === 'orthographic' ? Math.abs((h.scale ?? 0) - cad.orthoHeight / 2) <= 1e-3 * cad.orthoHeight : Math.abs((h.angle ?? 0) - 30) <= 1e-6);
  let last: HostCamera | null = null;
  await expect
    .poll(
      async () => {
        last = await hostCamera(page);
        return ok(last);
      },
      { timeout: 30_000, message: 'the project viewport has the Part camera' },
    )
    .toBe(true);
  return last!;
}

/**
 * Note when the header's leave status line shows during the next leave (window.__leaveSeen), and
 * every page toast the workspace draws meanwhile (window.__toastSeen).
 */
async function watchLeaveStatus(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __leaveSeen: string[]; __toastSeen: string[] };
    w.__leaveSeen = [];
    w.__toastSeen = [];
    const look = () => {
      const el = document.querySelector('[data-ws-leave-status]');
      const t = el?.textContent ?? '';
      if (t && !w.__leaveSeen.includes(t)) w.__leaveSeen.push(t);
      for (const toast of Array.from(document.querySelectorAll('#workspace-overlay [data-ws-toast]'))) {
        const s = toast.textContent ?? '';
        if (s && !w.__toastSeen.includes(s)) w.__toastSeen.push(s);
      }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}
const leaveSeen = (page: Page) => page.evaluate(() => (window as unknown as { __leaveSeen?: string[] }).__leaveSeen ?? []);
const toastSeen = (page: Page) => page.evaluate(() => (window as unknown as { __toastSeen?: string[] }).__toastSeen ?? []);

/** The app's question after a hook that did not finish: its words, then Stay (Enter) or Leave anyway. */
async function hookFailed(page: Page, leave: boolean) {
  const modal = page.locator('#modal-confirm');
  await expect(modal).toBeVisible({ timeout: 60_000 });
  const q = {
    title: await page.locator('#cf-heading').textContent(),
    copy: await page.locator('#cf-copy').textContent(),
    yes: await page.locator('#cf-confirm').textContent(),
    no: await page.locator('#cf-cancel').textContent(),
  };
  if (leave) await page.locator('#cf-confirm').click();
  else await page.keyboard.press('Enter');
  await expect(modal).toBeHidden();
  return q;
}

/** The app's checker on the Part's export as the project has it: exit 0 and "ok". */
function appCheck(dir: string, pid: string, sid: string): { code: number; out: string } {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(PYTHON, ['-m', 'magnusim_sdk.link', 'check', exportFile(pid, sid, 'part.bbrep'), exportFile(pid, sid, 'face_names.json')], { encoding: 'utf8', timeout: 120_000 });
  writeFileSync(join(dir, 'check.txt'), `${r.stdout ?? ''}${r.stderr ?? ''}`);
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const leaveStatus = (page: Page) => page.locator('[data-ws-leave-status]');

/** The app's own reading (project.tree): the Part's saved design is newer than the geometry's. */
async function behindOf(request: APIRequestContext, pid: string, gid: string): Promise<boolean | null> {
  const r = await request.get(`${base()}/api/project/tree?project_id=${pid}`);
  if (!r.ok()) return null;
  const node = (((await r.json()).geometries || []) as { id?: string; behind?: boolean }[]).find((g) => g.id === gid);
  return node ? node.behind === true : null;
}

/**
 * The geometry's row says the Part's design is newer ("Not up to date with Part 1."), with no
 * tick, as the user sees it right after a leave that linked nothing: WITHOUT a reload (the app
 * reads its tree again after such a leave, host fix 253d6a4). The app's own reading
 * (project.tree) says behind too.
 */
async function expectBehind(page: Page, request: APIRequestContext, pid: string, gid: string) {
  await expect.poll(() => behindOf(request, pid, gid), { timeout: 30_000 }).toBe(true);
  await expect(geometryRow(page, gid).locator('[data-geom-link-status]')).toHaveText('Not up to date with Part 1.', { timeout: 15_000 });
  await expect(geometryRow(page, gid).locator('.tree-check')).toHaveCount(0);
}

/** The save chip of a Part frame. */
const saveChip = (frame: FrameLocator) => frame.locator('[data-chip="save"]');

/** A Body's Include toggle in the tree (the Bodies folder opened first). */
async function includeToggle(frame: FrameLocator, body: string) {
  const folder = frame.locator('[data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row').click();
  return frame.locator(`[data-body-row="${body}"] [data-body-act="simulation"]`);
}

/**
 * A Part as a P1 build left it, with removed feature types (Box and Cylinder, decision
 * 2026-10-01): the record points at ws.data, and model.json holds the old features. Returns its id.
 */
async function oldPart(request: APIRequestContext, pid: string, title: string): Promise<string> {
  const created = await (await request.post(`${base()}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'cad', kind: 'part', title } })).json();
  const studyId = String(created.study.id);
  const rel = `studies/${studyId}/model.json`;
  const rec = await (await request.get(`${base()}/api/plugin-studies/get?${new URLSearchParams({ project_id: pid, plugin: 'cad', study_id: studyId })}`)).json();
  const upd = await request.post(`${base()}/api/plugin-studies/update`, { data: { project_id: pid, plugin: 'cad', study_id: studyId, rev: rec.study.rev, patch: { doc: { rel, schema: 1, store: 'data', view: `studies/${studyId}/view.json` } } } });
  expect(upd.ok(), await upd.text()).toBe(true);
  const w = await request.post(`${base()}/api/plugin-data/write`, {
    data: {
      project_id: pid,
      plugin: 'cad',
      rel,
      doc: {
        format: 'magnusim-cad/model',
        etag: '3.s_old',
        saved_at: '2026-09-30T20:00:00.000Z',
        doc: {
          schema: 1,
          units: { length: 'mm', angle: 'deg' },
          params: [],
          bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } },
          features: [
            { id: 'f_box', type: 'box', name: 'Old box', op: 'new', creates: 'b_1', scope: [], origin: ['0 mm', '0 mm', '0 mm'], size: ['20 mm', '20 mm', '20 mm'] },
            { id: 'f_cyl', type: 'cylinder', name: 'Old cylinder', op: 'cut', creates: null, scope: [], origin: ['10 mm', '10 mm', '-5 mm'], axis: 'origin:z', diameter: '10 mm', height: '40 mm' },
          ],
          meta: { created_at: '2026-09-30T19:00:00.000Z', written_by: '0.1.0' },
        },
      },
    },
  });
  expect(w.ok(), await w.text()).toBe(true);
  return studyId;
}
/** A study's record folder (a mesh's) on disk. */
function recordDir(pid: string, kind: 'mesh', id: string): string {
  const geoms = join(host!.projects, pid, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      const root = join(sims, s, kind === 'mesh' ? 'meshes' : 'simulation_runs');
      if (!existsSync(root)) continue;
      for (const f of readdirSync(root)) {
        try {
          if (JSON.parse(readFileSync(join(root, f, 'id.json'), 'utf8')).id === id) return join(root, f);
        } catch {
          /* not a record */
        }
      }
    }
  }
  throw new Error(`no ${kind} ${id}`);
}

/** "Mesh 1" of a simulation as its generate leaves it at geometry `rev` (a whole polyMesh, no WSL). */
async function generatedMesh(request: APIRequestContext, pid: string, simId: string, rev: number): Promise<string> {
  const m = await request.post(`${base()}/api/mesh`, { data: { project_id: pid, simulation_id: simId, name: 'Mesh 1' } });
  const mj = await m.json();
  expect(m.ok(), JSON.stringify(mj)).toBe(true);
  const meshId = String(mj.mesh.id);
  const meshDir = recordDir(pid, 'mesh', meshId);
  const caseDir = join(meshDir, 'case');
  mkdirSync(join(caseDir, 'constant', 'polyMesh'), { recursive: true });
  for (const n of ['points', 'faces', 'owner', 'neighbour']) writeFileSync(join(caseDir, 'constant', 'polyMesh', n), `${n}\n`);
  writeFileSync(
    join(caseDir, 'constant', 'polyMesh', 'boundary'),
    [
      'FoamFile { version 2.0; format ascii; class polyBoundaryMesh; location "constant/polyMesh"; object boundary; }',
      '1',
      '(',
      '    wall',
      '    {',
      '        type            wall;',
      '        nFaces          1;',
      '        startFace       0;',
      '    }',
      ')',
      '',
    ].join('\n'),
  );
  const meshFile = join(meshDir, 'mesh.json');
  writeFileSync(
    meshFile,
    JSON.stringify({
      ...JSON.parse(readFileSync(meshFile, 'utf8')),
      generated: true,
      live_mesh_result: { status: 'done', generate_id: 'g-e2e', built_from_rev: rev, n_cells: 8, n_points: 27, case_dir: caseDir, mesh_path: join(caseDir, 'constant', 'polyMesh') },
    }),
  );
  return meshId;
}

/** Home lists the app's seeded sample projects, whose thumbnails 404 on a fresh e2e root (the app's, not CAD's). */
const notHomeThumbs = (errors: string[]) => errors.filter((e) => !/status of 404 \(Not Found\) \(https?:\/\/[^/]+\/api\/geometry\/thumb\?project_id=sample-/.test(e));

test.describe('gate:l3-cad exit sync', () => {
  test.beforeEach(() => {
    if (REQUIRE && !PYTHON) throw new Error(`gate:l3-cad needs the app's Python for magnusim_sdk.link check: ${appPythonMissing(FOUND)}`);
  });
  test.skip(!REQUIRE && !PYTHON, `needs the app's Python for magnusim_sdk.link check: ${appPythonMissing(FOUND)}`);

  test('cad:l3-first-exit Back creates Part 1 and lands in the main viewport showing it, with the Part camera; the header shows the export while it is written', async ({ page, request }, testInfo) => {
    test.setTimeout(300_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit first');
    await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    expect(await linkedOf(request, pid, sid)).toBeNull();
    // A view no framing makes: from the front-right, above, looking past the part's middle.
    const cam = await setCadCamera(page, { position: [210, -260, 150], target: [25, 10, 8], up: [0, 0, 1], orthoHeight: 120, projection: 'perspective' });
    expect(cam.projection).toBe('perspective');
    await shot(page, 'l3-before-exit');

    // Back: the export is written while the header says so (the files' commit held a moment).
    const held: { route: import('@playwright/test').Route }[] = [];
    let holding = true;
    await page.route('**/api/plugin-files/uploads/*/commit*', async (route) => {
      if (!holding) return route.continue();
      held.push({ route });
    });
    await watchLeaveStatus(page);
    const before = await landings(page);
    await backButton(page).click();
    await expect(leaveStatus(page)).toHaveText('Writing Part 1 for the project', { timeout: 10_000 });
    await expect(page.locator('[data-ws-leave-cover]')).toBeVisible();
    await expect(backButton(page)).toBeDisabled();
    await shot(page, 'l3-exit-progress');
    holding = false;
    for (const h of held.splice(0)) await h.route.continue().catch(() => {});
    await page.unroute('**/api/plugin-files/uploads/*/commit*');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await awaitLanding(page, before);
    // The Part's own step, then the app's stages of the link (the save before it took under 400 ms);
    // "Finishing" names what is left (host 253d6a4: "Finishing: the thumbnail (1 of 2 done)").
    const said = await leaveSeen(page);
    expect(said[0]).toBe('Writing Part 1 for the project');
    expect(said.filter((s) => /^Finishing: the .+$/.test(s)).length, said.join(' | ')).toBeGreaterThan(0);
    expect(said.filter((s) => /^Finishing\b/.test(s) && !/^Finishing: the .+$/.test(s)), 'a bare "Finishing"').toEqual([]);

    // The project has "Part 1", linked to the Part, and the viewport shows it.
    const linked = (await linkedOf(request, pid, sid))!;
    expect([linked.name, linked.rev]).toEqual(['Part 1', 1]);
    const gid = linked.geometryId;
    expect(await lastLanding(page)).toMatchObject({ geometryId: gid, reason: 'back' });
    await expect(geometryRow(page, gid).locator('.tl').first()).toHaveText('Part 1', { timeout: 60_000 });
    await expect(geometryRow(page, gid).locator('[data-geom-from]')).toHaveText('from Part 1');
    await expect(geometryRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0);
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(gid);
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(await partMeta(request, pid, gid)).toEqual({ zmax: 20, faces: 6 });
    // The camera the Part had.
    const landed = await expectSameView(page, cam);
    expect(landed.parallel).toBe(false);
    await shot(page, 'l3-landing-same-camera');
    // The export the app linked passes the app's own checker.
    const check = appCheck(testInfo.outputPath('export'), pid, sid);
    expect(check.out).toBe('ok');
    expect(check.code).toBe(0);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test("cad:l3-question edit, exit: the app's question inside the leave; Keep editing stays in the Part; Overwrite updates in place and a Wall on a named face stays on it; Save as new lands on Part 1 v2", async ({ page, request }) => {
    test.setTimeout(600_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit question');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    // A Wall on the face the Part calls "Extrude 1 · Side 2": setup the app protects.
    const sc1 = sidecarOf(pid, sid);
    const side2 = sc1.faces.find((f) => f.body === 1 && f.label === 'Extrude 1 · Side 2')!.index;
    const sim = await request.post(`${base()}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
    const simj = await sim.json();
    expect(sim.ok(), JSON.stringify(simj)).toBe(true);
    const bc = await request.post(`${base()}/api/bcs`, { data: { project_id: pid, simulation_id: simj.simulation.id, name: 'Side wall', bc_type: 'Wall', faces: [`face ${side2}@Body1`], geometry_rev: 1 } });
    const bcj = await bc.json();
    expect(bc.ok(), JSON.stringify(bcj)).toBe(true);

    // A notch cut through Side 1, then taller: the faces are numbered anew (Side 2 is not face
    // 3 any more), then Back: the app asks inside the leave; the header waits for the choice.
    let frame = await reopen(page);
    await addSolid(page, { at: [15, -5, 0], size: [10, 10, 20], op: 'cut', scope: [made.body!] });
    await setHeight(page, made.extrude, 30);
    await watchLeaveStatus(page);
    await backButton(page).click();
    const q = await readLinkQuestion(page);
    expect([q.title, q.overwrite, q.overwriteDisabled, q.newLabel, q.cancel]).toEqual(['Part 1 has a new shape', 'Overwrite Part 1', false, 'Save as new geometry', 'Keep editing']);
    expect(q.copy).toBe(`Part 1 is used by ${simj.simulation.name}. How should the simulation get the new shape?`);
    await expect(leaveStatus(page)).toHaveText('Waiting for your choice');
    await shot(page, 'l3-question-during-exit');
    // Keep editing: the Part stays open as it was, with no other question; nothing changed.
    const errorsBefore = seen.errors.length;
    await answerLinkQuestion(page, 'cancel');
    await expect(page).toHaveURL(new RegExp(`/ws/cad/part/${sid}$`));
    await expect(page.locator('#workspace-overlay')).toBeVisible();
    await expect(leaveStatus(page)).toHaveCount(0);
    await expect(backButton(page)).toBeEnabled();
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved');
    expect(await workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { leave: { last: { outcome: { outcome: string } | null } | null } } }).__CAD__.leave.last?.outcome?.outcome)).toBe('kept-editing');
    expect((await linkedOf(request, pid, sid))!.rev).toBe(1);
    expect((await partMeta(request, pid, gid)).zmax).toBe(20);
    // Nothing uncaught in the app's page after Keep editing (its "You kept editing" rejection
    // was logged as an uncaught BridgeError before the host fix cb62201), and no other error.
    await page.waitForTimeout(1_000);
    expect(seen.errors.slice(errorsBefore), 'no page or console error after Keep editing').toEqual([]);

    // Back again, Overwrite: the same geometry, rev 2, the new height; the Wall on the same face.
    let before = await landings(page);
    await backButton(page).click();
    await answerLinkQuestion(page, 'overwrite');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await awaitLanding(page, before);
    const ow = (await linkedOf(request, pid, sid))!;
    expect([ow.geometryId, ow.rev]).toEqual([gid, 2]);
    expect((await partMeta(request, pid, gid)).zmax).toBe(30);
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(gid);
    const sc2 = sidecarOf(pid, sid);
    // The cut renumbered the faces: Side 2 has another index now (a Wall kept by its old index
    // would be on another face) ...
    const side2Now = sc2.faces.filter((f) => f.body === 1 && f.label === 'Extrude 1 · Side 2').map((f) => f.index);
    expect(side2Now).toHaveLength(1);
    expect(side2Now[0], `Side 2 was face ${side2}; the cut must renumber it`).not.toBe(side2);
    expect((await partMeta(request, pid, gid)).faces).toBe(10);
    // ... and the Wall followed it by name.
    const bcs = (await (await request.get(`${base()}/api/bcs?project_id=${pid}&simulation_id=${simj.simulation.id}`)).json()).boundary_conditions as { id: string; faces: string[]; lost_faces?: unknown[] }[];
    const wall = bcs.find((b) => b.id === bcj.bc.id)!;
    const labelOf = (f: string) => sc2.faces.find((x) => x.index === Number(/face (\d+)@/.exec(f)![1]))?.label;
    expect(wall.faces).toEqual([`face ${side2Now[0]}@Body1`]);
    expect(wall.faces.map(labelOf)).toEqual(['Extrude 1 · Side 2']);
    expect(wall.lost_faces ?? []).toEqual([]);
    await expect(geometryRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0);

    // Save as new: "Part 1 v2", shown in the viewport; "Part 1" stays as it was.
    frame = await reopen(page);
    await setHeight(page, made.extrude, 35);
    before = await landings(page);
    await backButton(page).click();
    await answerLinkQuestion(page, 'new');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    // The setup was copied onto the new geometry: the app's report says so (the one report this setup needs).
    await awaitLanding(page, before, { report: 'Part 1 v2 added' });
    const sn = (await linkedOf(request, pid, sid))!;
    expect(sn.name).toBe('Part 1 v2');
    expect(sn.geometryId).not.toBe(gid);
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(sn.geometryId);
    expect((await partMeta(request, pid, sn.geometryId)).zmax).toBe(35);
    expect((await partMeta(request, pid, gid)).zmax).toBe(30);
    await expect(geometryRow(page, sn.geometryId).locator('[data-geom-from]')).toHaveText('from Part 1', { timeout: 60_000 });
    void frame;
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-no-change an exit with no change exports nothing, links nothing and lands at once, with an orthographic camera', async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit no change');
    await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const first = (await linkedOf(request, pid, sid))!;
    const mtimes = () => [statSync(exportFile(pid, sid, 'part.bbrep')).mtimeMs, statSync(exportFile(pid, sid, 'face_names.json')).mtimeMs];
    const m0 = mtimes();

    await reopen(page);
    // Orthographic, from the back-left: a view change only (no design change).
    await workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { setProjection(p: string): void } } } } } }).__CAD__.services.viewport.get().handle.setProjection('orthographic'));
    const cam = await setCadCamera(page, { position: [-180, 220, 90], target: [20, 15, 10], up: [0, 0, 1], orthoHeight: 95, projection: 'orthographic' });
    expect([cam.projection, cam.orthoHeight]).toEqual(['orthographic', 95]);
    const links: string[] = [];
    const onReq = (r: import('@playwright/test').Request) => {
      if (/\/api\/plugin-geometry\/link(\?|$)/.test(r.url())) links.push(r.url());
    };
    page.on('request', onReq);
    await watchLeaveStatus(page);
    const before = await landings(page);
    const t0 = performance.now();
    await backButton(page).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
    const closedMs = performance.now() - t0;
    await awaitLanding(page, before);
    page.off('request', onReq);
    // Quick: the workspace closed before the app draws any progress (400 ms), with nothing written or linked.
    expect(await leaveSeen(page)).toEqual([]);
    expect(closedMs).toBeLessThan(3_000);
    expect(links).toEqual([]);
    expect(mtimes()).toEqual(m0);
    expect((await linkedOf(request, pid, sid))!.rev).toBe(first.rev);
    expect(await lastLanding(page)).toMatchObject({ geometryId: first.geometryId, reason: 'back', landed: 'none' });
    // The orthographic camera, its full visible height (the app's parallel scale is half of it).
    const landed = await expectSameView(page, cam);
    expect(landed.parallel).toBe(true);
    expect(landed.scale).toBeCloseTo(47.5, 3);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test("cad:l3-refused a feature that fails to build: the app's question with CAD's words; Stay keeps the Part; Leave anyway leaves the geometry as it was", async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit refused');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    const frame = await reopen(page);
    // A Split by the Right plane 500 mm off: it cuts nothing, so it fails (red in the tree).
    await workspaceFrame(page).evaluate((body) => {
      const doc = (window as unknown as { __CAD__: { services: { doc: { beginNew(t: string, init: unknown): { feature: string; commit(): void } } } } }).__CAD__.services.doc;
      doc.beginNew('split', { targets: [body], tool: { kind: 'plane', plane: 'origin:right', offset: '500 mm' } }).commit();
    }, made.body!);
    await settled(page);
    await expect(frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="split"]')).toHaveAttribute('data-state', 'error');

    await backButton(page).click();
    const stay = await hookFailed(page, false);
    expect(stay).toEqual({
      title: "Couldn't update the project",
      copy: 'Magnusim CAD: Split 1 failed to build. Fix, retry or suppress it first. Part 1 keeps its last update.',
      yes: 'Leave anyway',
      no: 'Stay',
    });
    // Stay: the Part, as it was.
    await expect(page).toHaveURL(new RegExp(`/ws/cad/part/${sid}$`));
    await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    expect((await linkedOf(request, pid, sid))!.rev).toBe(1);

    // Leave anyway: the project, and the geometry keeps its last update (the row says the design is newer).
    await backButton(page).click();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 60_000 });
    await shot(page, 'l3-refused-question');
    await hookFailed(page, true);
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 60_000 });
    expect((await linkedOf(request, pid, sid))!.rev).toBe(1);
    expect((await partMeta(request, pid, gid)).zmax).toBe(20);
    // The app reads the design as newer (the row itself, without a reload: cad:l3-behind-row-refused).
    await expect.poll(() => behindOf(request, pid, gid), { timeout: 30_000 }).toBe(true);
    await landingDialog(page, null);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-behind-row-refused after Leave anyway on a refused link, the row says the Part is newer, with no tick, without a reload', async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit behind refused');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    // Up to date first: no status line, the tick.
    await expect(geometryRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0, { timeout: 30_000 });
    await expect(geometryRow(page, gid).locator('.tree-check')).toHaveCount(1);
    await reopen(page);
    await workspaceFrame(page).evaluate((body) => {
      const doc = (window as unknown as { __CAD__: { services: { doc: { beginNew(t: string, init: unknown): { feature: string; commit(): void } } } } }).__CAD__.services.doc;
      doc.beginNew('split', { targets: [body], tool: { kind: 'plane', plane: 'origin:right', offset: '500 mm' } }).commit();
    }, made.body!);
    await settled(page);
    await backButton(page).click();
    await hookFailed(page, true);
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 60_000 });
    await expectBehind(page, request, pid, gid);
    await landingDialog(page, null);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-behind-row-no-body after a leave with nothing included, the row says the Part is newer, with no tick, without a reload', async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit behind no body');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    await expect(geometryRow(page, gid).locator('.tree-check')).toHaveCount(1, { timeout: 30_000 });
    const frame = await reopen(page);
    await (await includeToggle(frame, made.body!)).click();
    await expect(frame.locator(`[data-body-row="${made.body}"]`)).toHaveAttribute('data-in-simulation', '0');
    await settled(page);
    await backButton(page).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
    await expectBehind(page, request, pid, gid);
    await landingDialog(page, null);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-no-body nothing included: the header says so for 3 s with no page toast, the leave goes on, and the geometry keeps its last update', async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit no body');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    const frame = await reopen(page);
    await (await includeToggle(frame, made.body!)).click();
    await expect(frame.locator(`[data-body-row="${made.body}"]`)).toHaveAttribute('data-in-simulation', '0');
    await settled(page);
    await watchLeaveStatus(page);
    const t0 = performance.now();
    await backButton(page).click();
    await expect(leaveStatus(page)).toHaveText('No body is included in the simulation; Part 1 keeps its last update.', { timeout: 10_000 });
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
    // Held to be read (3 s), in the header only: no page toast said it a second time (L3 review polish 3).
    expect(performance.now() - t0).toBeGreaterThanOrEqual(2_900);
    expect(await leaveSeen(page)).toContain('No body is included in the simulation; Part 1 keeps its last update.');
    expect(await toastSeen(page)).toEqual([]);
    expect((await linkedOf(request, pid, sid))!.rev).toBe(1);
    expect((await partMeta(request, pid, gid)).zmax).toBe(20);
    await expect.poll(() => behindOf(request, pid, gid), { timeout: 30_000 }).toBe(true);
    await landingDialog(page, null);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-save-on-its-way a save still on its way: the exit waits for it, then links; a save that does not land ends at 25 s with CAD words (before the app 30 s stall); Stay keeps the Part', async ({ page, request }) => {
    test.setTimeout(400_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit saving');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    let frame = await reopen(page);
    // 1. The save held a few seconds: "Saving Part 1" with Cancel over the covered Part; then it lands and links.
    let hold = await holdCommits(page);
    await setHeightNoWait(page, made.extrude, 26);
    await expect.poll(() => hold.held(), { timeout: 20_000 }).toBeGreaterThan(0);
    await watchLeaveStatus(page);
    let before = await landings(page);
    await backButton(page).click();
    await expect(leaveStatus(page)).toHaveText('Saving Part 1', { timeout: 10_000 });
    await expect(page.locator('[data-ws-leave-cover]')).toBeVisible();
    await expect(page.locator('[data-ws-leave-cancel]')).toHaveText('Cancel');
    await expect(backButton(page)).toBeDisabled();
    await page.waitForTimeout(3_000);
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await hold.release();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await awaitLanding(page, before);
    expect((await linkedOf(request, pid, sid))!.rev).toBe(2);
    expect((await partMeta(request, pid, gid)).zmax).toBe(26);
    expect((await leaveSeen(page))[0]).toBe('Saving Part 1');

    // 2. A save that does not land: CAD's own words at 25 s, before the app's 30 s stall question.
    frame = await reopen(page);
    hold = await holdCommits(page);
    await setHeightNoWait(page, made.extrude, 31);
    await expect.poll(() => hold.held(), { timeout: 20_000 }).toBeGreaterThan(0);
    // Durations on the monotonic clock, as the page's timers run: the wall clock can be stepped
    // meanwhile (the Linux CI mirror under WSL: the page's 25 s timer fired 22.1 s later by
    // Date.now(), 25.0 s by the monotonic clock).
    const t0 = performance.now();
    await backButton(page).click();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 40_000 });
    const tq = Math.round(performance.now() - t0);
    console.log(`[cad-link-exit] stuck save: the question after ${tq} ms`);
    expect(tq).toBeGreaterThanOrEqual(24_000);
    expect(tq).toBeLessThan(29_500);
    const stuck = await hookFailed(page, false);
    expect(stuck).toEqual({
      title: "Couldn't update the project",
      copy: 'Magnusim CAD: Part 1 is still saving after 25 seconds. Part 1 keeps its last update. Its changes are not saved. Leaving discards them.',
      yes: 'Leave anyway',
      no: 'Stay',
    });
    // Stay: the Part, its save still on its way; once it lands the Part says Saved, and Back links it.
    await expect(page).toHaveURL(new RegExp(`/ws/cad/part/${sid}$`));
    await expect(saveChip(frame)).toHaveText('Saving…');
    await hold.release();
    await expect(saveChip(frame)).toHaveText('Saved', { timeout: 30_000 });
    before = await landings(page);
    await backButton(page).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await awaitLanding(page, before);
    expect((await linkedOf(request, pid, sid))!.rev).toBe(3);
    expect((await partMeta(request, pid, gid)).zmax).toBe(31);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-save-refused a linked Part whose save the app refuses: "Couldn\'t update the project" with the reason, not the Part name twice; Retry, then Back links', async ({ page, request }) => {
    test.setTimeout(300_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit save refused');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    const frame = await reopen(page);
    const commit = '**/api/plugin-files/uploads/*/commit*';
    let room = false;
    await page.route(commit, async (route) => {
      if (room) return route.continue();
      await route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'there is not enough free disk space for this file', code: 'disk_full' }) });
    });
    try {
      await setHeightNoWait(page, made.extrude, 27);
      await expect(saveChip(frame).locator('.cad-chip-v')).toHaveText('Not saved: the disk is full', { timeout: 30_000 });
      await backButton(page).click();
      const q = await hookFailed(page, false);
      expect(q).toEqual({
        title: "Couldn't update the project",
        copy: 'Magnusim CAD: Saving failed: the disk is full. Part 1 keeps its last update. Its changes are not saved. Leaving discards them.',
        yes: 'Leave anyway',
        no: 'Stay',
      });
      await expect(page).toHaveURL(new RegExp(`/ws/cad/part/${sid}$`));
      room = true;
      await saveChip(frame).locator('[data-chip-action="Retry"]').click();
      await expect(saveChip(frame)).toHaveText('Saved', { timeout: 30_000 });
    } finally {
      await page.unroute(commit);
    }
    const before = await landings(page);
    await backButton(page).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await awaitLanding(page, before);
    expect((await linkedOf(request, pid, sid))!.rev).toBe(2);
    expect((await partMeta(request, pid, gid)).zmax).toBe(27);
    expect(seen.csp, 'CSP violations').toEqual([]);
    // The browser logs the host's refusals (the 507s this test answered) as failed loads; nothing else.
    expect(seen.errors.filter((e) => !/status of 507 .*\/api\/plugin-files\/uploads\/[^/]+\/commit/.test(e)), 'console errors').toEqual([]);
  });

  test('cad:l3-clean-second-tab a tab with no change of its own that another tab saved over: "Updated in another tab", Reload only, not dirty; its exit reads the newer design and links it without asking', async ({ page, request }) => {
    test.setTimeout(400_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit second tab');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    await reopen(page);
    // Tab B: the same Part, as it is (saved).
    const b = await page.context().newPage();
    const seenB = await watchPage(b);
    await b.goto(page.url());
    const fb = await partOpened(b);
    await expect(fb.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    await hookOn(b);
    await settled(b);
    // Tab A makes it taller and saves (A stays open).
    await page.bringToFront();
    await setHeight(page, made.extrude, 30);
    // B gets the focus back: it says so before any edit, offers only Reload, and is not dirty.
    await b.bringToFront();
    await b.locator('#workspace-overlay [data-ws-back]').focus();
    await fb.locator('[data-cad-tree]').first().click({ position: { x: 5, y: 5 } });
    await expect(saveChip(fb)).toHaveText(/^Updated in another tab/, { timeout: 30_000 });
    await expect(saveChip(fb)).toHaveAttribute('data-state', 'updated');
    await expect(saveChip(fb).locator('[data-chip-action]')).toHaveText(['Reload']);
    await expect(b.locator('#workspace-overlay [data-ws-dirty]')).toHaveCount(0);
    await shot(b, 'l3-clean-second-tab');
    // B's Back: no question; B reads A's design in place and links it (A has not left yet).
    const beforeB = await landings(b);
    await backButton(b).click();
    await expect(b).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await awaitLanding(b, beforeB);
    const afterB = (await linkedOf(request, pid, sid))!;
    expect([afterB.geometryId, afterB.rev]).toEqual([gid, 2]);
    expect((await partMeta(request, pid, gid)).zmax).toBe(30);
    // A's Back: its design is the linked one now; nothing to do, and nothing asks.
    await page.bringToFront();
    await backAndLand(page, pid);
    expect((await linkedOf(request, pid, sid))!.rev).toBe(2);
    await b.close();
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
    expect(seenB.errors, 'console errors in tab B').toEqual([]);
  });

  test('cad:l3-removed-feature an old Part with removed features: the notice names them; the exit says to suppress or delete them; Suppress them is one undoable step, then the Part links', async ({ page, request }) => {
    test.setTimeout(400_000);
    const seen = await watchPage(page);
    const pid = await newProject(request, 'CAD exit removed');
    const studyId = await oldPart(request, pid, 'Old part');
    await openProject(page, pid);
    const frame = await reopen(page, 'Old part');
    const notice = frame.locator('[data-chip="removed"]');
    await expect(notice.locator('.cad-chip-v')).toHaveText('This Part uses removed features: Old box and Old cylinder');
    await expect(notice.locator('[data-chip-action]')).toHaveText(['Suppress them']);
    await shot(page, 'l3-removed-notice');
    // Back as it is: what to do, in CAD's words (not "Fix, retry or suppress", which does not apply).
    await backButton(page).click();
    expect(await hookFailed(page, false)).toEqual({
      title: "Couldn't update the project",
      copy: 'Magnusim CAD: Old box and Old cylinder are removed features (Box, Cylinder). Suppress or delete them, then leave. The project is unchanged.',
      yes: 'Leave anyway',
      no: 'Stay',
    });
    await expect(page).toHaveURL(new RegExp(`/ws/cad/part/${studyId}$`));
    // Suppress them: both, in one step; the notice goes. Undo brings both back, Redo suppresses both.
    const suppressed = () => frame.locator('[data-cad-tree] [data-feature-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-suppressed') === '1'));
    await notice.locator('[data-chip-action="Suppress"]').click();
    await expect.poll(suppressed).toEqual([true, true]);
    await expect(notice).toHaveCount(0);
    await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
    await expect.poll(suppressed).toEqual([false, false]);
    await expect(notice).toBeVisible();
    await frame.locator('[data-cad-toolbar] [data-command="edit.redo"]').click();
    await expect.poll(suppressed).toEqual([true, true]);
    await expect(notice).toHaveCount(0);
    // A block, then Back: the Part goes to the project as any other.
    await addSolid(page, { size: [20, 20, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const linked = (await linkedOf(request, pid, studyId))!;
    expect([linked.name, linked.rev]).toEqual(['Old part', 1]);
    expect(await partMeta(request, pid, linked.geometryId)).toEqual({ zmax: 20, faces: 6 });
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-background a slow update (the compute slot busy): Continue in background closes the Part; the project shows it queued, then the new part', async ({ page, request }) => {
    test.setTimeout(400_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit background');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    await reopen(page);
    await setHeight(page, made.extrude, 30);
    let held = false;
    try {
      const h = await request.post(`${base()}/api/test/slot-hold`);
      expect(h.ok(), await h.text()).toBe(true);
      held = true;
      await backButton(page).click();
      await expect(leaveStatus(page)).toHaveText(/^Queued( behind \d+ jobs?)? \(see Queue\)$/, { timeout: 60_000 });
      await expect(page.locator('[data-ws-leave-background]')).toBeVisible();
      await expect(page.locator('[data-ws-leave-cancel]')).toHaveText('Stay here');
      await shot(page, 'l3-continue-in-background');
      await page.locator('[data-ws-leave-background]').click();
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
      await expect(geometryRow(page, gid).locator('[data-geom-link-status]')).toHaveText('Queued', { timeout: 30_000 });
      expect((await linkedOf(request, pid, sid))!.rev).toBe(1);
      const before = await landings(page);
      await request.post(`${base()}/api/test/slot-release`);
      held = false;
      await request.post(`${base()}/api/compute-queue/kick`, { data: { project_id: pid } });
      await awaitLanding(page, before);
      await expect.poll(async () => (await linkedOf(request, pid, sid))!.rev, { timeout: 120_000 }).toBe(2);
      expect((await partMeta(request, pid, gid)).zmax).toBe(30);
      await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(gid);
      await expect(geometryRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0, { timeout: 60_000 });
    } finally {
      if (held) await request.post(`${base()}/api/test/slot-release`);
    }
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-other-exits browser Back, opening another project and Home sync the Part too', async ({ page, request }) => {
    test.setTimeout(500_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit other ways');
    const other = await newProject(request, 'CAD exit elsewhere');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    const exits: { reason: string; height: number; go: () => Promise<unknown>; arrived: () => Promise<void> }[] = [
      {
        reason: 'history',
        height: 25,
        go: () => page.goBack(),
        arrived: () => expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 }),
      },
      {
        reason: 'project',
        height: 35,
        go: () => page.evaluate((id) => (window as unknown as { __CFD_HOME__: { open(id: string): Promise<unknown> } }).__CFD_HOME__.open(id), other),
        arrived: () => expect.poll(() => page.evaluate(() => (window as unknown as { __CFD_PROJECT_READY__?: string }).__CFD_PROJECT_READY__), { timeout: 180_000 }).toBe(other),
      },
      {
        reason: 'home',
        height: 45,
        go: () => page.evaluate(() => document.getElementById('wb-home')!.click()),
        arrived: () => expect.poll(() => page.evaluate(() => document.body.classList.contains('on-home')), { timeout: 180_000 }).toBe(true),
      },
    ];
    let rev = 1;
    for (const exit of exits) {
      if (!page.url().endsWith(`#/p/${pid}`)) await openProject(page, pid);
      await reopen(page);
      await setHeight(page, made.extrude, exit.height);
      const before = await landings(page);
      await exit.go();
      await exit.arrived();
      rev += 1;
      await expect.poll(async () => (await linkedOf(request, pid, sid))!.rev, { timeout: 180_000 }).toBe(rev);
      expect((await partMeta(request, pid, gid)).zmax).toBe(exit.height);
      if (exit.reason === 'history') {
        await awaitLanding(page, before);
        expect(await lastLanding(page)).toMatchObject({ geometryId: gid, reason: 'history' });
      }
    }
    // The project again: the part shown is the last update, the row up to date.
    await openProject(page, pid);
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(gid);
    await expect(geometryRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0, { timeout: 60_000 });
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(notHomeThumbs(seen.errors), 'console errors').toEqual([]);
  });

  test("cad:l3-typed a value typed and not applied: the saved design is linked, then the app's usual question; Stay keeps the text, Leave discards it", async ({ page, request }) => {
    test.setTimeout(400_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit typed');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    const frame = await reopen(page);
    await setHeight(page, made.extrude, 25);
    // Extrude 1's panel, 17 typed in Distance with no Enter.
    await frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: /^Extrude 1$/ }) }).locator('> .tree-row').dblclick();
    const input = frame.locator('[data-cad-panel="feature"] .nui[data-field="distance"] input');
    await input.click();
    await input.fill('17');
    await expect(input).toBeFocused();
    await backButton(page).click();
    // The hook linked the saved design (25), then the app asks about the typed text, as it always has.
    await expect(page.locator('#cf-heading')).toHaveText('Leave without saving?', { timeout: 60_000 });
    await expect(page.locator('#cf-copy')).toHaveText('Magnusim CAD: Changes typed in Distance of Part 1 are not applied yet. Leaving discards them.');
    await expect.poll(async () => (await linkedOf(request, pid, sid))!.rev, { timeout: 60_000 }).toBe(2);
    expect((await partMeta(request, pid, gid)).zmax).toBe(25);
    // Stay: the text is still typed in its field (the update's report, if the app shows one now, OK).
    await answerLeave(page, false);
    await expect(page).toHaveURL(new RegExp(`/ws/cad/part/${sid}$`));
    // No report of the update just made: nothing of the setup changed.
    await page.waitForTimeout(LATE_REPORT_MS);
    await landingDialog(page, null);
    await expect(input).toHaveValue('17');
    await expect(frame.locator('[data-chip="save"]')).toHaveText('Not applied: press Enter');
    // Typed again (the pointer leaving the frame applies only a value the user stopped typing a
    // moment ago, so this one stays typed), Back, Leave: the typed text is discarded; the geometry
    // has the saved design.
    await input.click();
    await input.fill('18');
    await backButton(page).click();
    await expect(page.locator('#cf-heading')).toHaveText('Leave without saving?', { timeout: 60_000 });
    await answerLeave(page, true);
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 60_000 });
    expect((await linkedOf(request, pid, sid))!.rev).toBe(2);
    expect((await partMeta(request, pid, gid)).zmax).toBe(25);
    const f = await reopen(page);
    await f.locator('[data-cad-tree] [data-feature-row]').filter({ has: f.locator('> .tree-row .tl', { hasText: /^Extrude 1$/ }) }).locator('> .tree-row').dblclick();
    await expect(f.locator('[data-cad-panel="feature"] .nui[data-field="distance"] input')).toHaveValue('25');
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:l3-report the update report: none when nothing of the setup changed, a mesh left out of date is a toast; a face a boundary condition holds that moved far is a dialog naming it, and the landing does not wait for its OK', async ({ page, request }) => {
    test.setTimeout(480_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit report');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    const faceIndex = (label: string) => {
      const f = sidecarOf(pid, sid).faces.filter((x) => x.body === 1 && x.label === label);
      expect(f, `one face labelled ${label}`).toHaveLength(1);
      return f[0].index;
    };
    // In use: a simulation with a Wall on the bottom (it stays put as the part grows), and a mesh
    // generated at rev 1.
    const sim = await request.post(`${base()}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
    const simj = await sim.json();
    expect(sim.ok(), JSON.stringify(simj)).toBe(true);
    const simName = String(simj.simulation.name);
    const floor = await request.post(`${base()}/api/bcs`, { data: { project_id: pid, simulation_id: simj.simulation.id, name: 'Floor', bc_type: 'Wall', faces: [`face ${faceIndex('Extrude 1 · Start')}@Body1`], geometry_rev: 1 } });
    expect(floor.ok(), await floor.text()).toBe(true);
    await generatedMesh(request, pid, String(simj.simulation.id), 1);

    // 1. Taller (20 to 30 mm), Overwrite: the Floor did not move, so no dialog; the mesh made at
    //    rev 1 is said quietly, in a toast.
    await reopen(page);
    await setHeight(page, made.extrude, 30);
    let before = await landings(page);
    await backButton(page).click();
    await answerLinkQuestion(page, 'overwrite');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await awaitLanding(page, before, { toast: 'Part 1 updated. Out of date: Mesh 1. Generate it again before you run.' });
    expect((await linkedOf(request, pid, sid))!.rev).toBe(2);
    expect((await partMeta(request, pid, gid)).zmax).toBe(30);

    // 2. A Wall "Lid" on the top, then much taller (30 to 50 mm): the top is kept by its name but
    //    moved far. The report names the record and the face (by CAD's label), and the mesh; the
    //    landing has ended while it is still open (nothing waits for its OK).
    const lid = await request.post(`${base()}/api/bcs`, { data: { project_id: pid, simulation_id: simj.simulation.id, name: 'Lid', bc_type: 'Wall', faces: [`face ${faceIndex('Extrude 1 · End')}@Body1`], geometry_rev: 2 } });
    expect(lid.ok(), await lid.text()).toBe(true);
    await reopen(page);
    await setHeight(page, made.extrude, 50);
    before = await landings(page);
    await backButton(page).click();
    await answerLinkQuestion(page, 'overwrite');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    await expect(page.locator('#modal-confirm')).toBeVisible();
    await shot(page, 'l3-report-moved-far');
    await awaitLanding(page, before, {
      report: 'Part 1 updated',
      lines: [KEPT_BY_NAME, `Kept by name but moved far: ${simName} › Lid ('Extrude 1 · End'). Check it.`, 'Out of date: Mesh 1. Generate it again before you run.'],
    });
    expect((await linkedOf(request, pid, sid))!.rev).toBe(3);
    expect((await partMeta(request, pid, gid)).zmax).toBe(50);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test("cad:l3-background-camera Continue in background lands with the Part's camera (given with the link), perspective and orthographic", async ({ page, request }) => {
    test.setTimeout(480_000);
    const { seen, pid, sid } = await freshPart(page, request, 'CAD exit background camera');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, pid, sid))!.geometryId;
    const rounds: { height: number; cam: CadCamera }[] = [
      { height: 30, cam: { position: [190, -240, 140], target: [22, 12, 9], up: [0, 0, 1], orthoHeight: 120, projection: 'perspective' } },
      { height: 40, cam: { position: [-170, 210, 95], target: [18, 14, 12], up: [0, 0, 1], orthoHeight: 85, projection: 'orthographic' } },
    ];
    let rev = 1;
    for (const round of rounds) {
      await reopen(page);
      await setHeight(page, made.extrude, round.height);
      await workspaceFrame(page).evaluate(
        (p) => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { setProjection(p: string): void } } } } } }).__CAD__.services.viewport.get().handle.setProjection(p),
        round.cam.projection,
      );
      const cam = await setCadCamera(page, round.cam);
      expect([cam.projection, cam.position]).toEqual([round.cam.projection, round.cam.position]);
      let held = false;
      try {
        const h = await request.post(`${base()}/api/test/slot-hold`);
        expect(h.ok(), await h.text()).toBe(true);
        held = true;
        await backButton(page).click();
        await expect(page.locator('[data-ws-leave-background]')).toBeVisible({ timeout: 60_000 });
        await page.locator('[data-ws-leave-background]').click();
        await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
        const before = await landings(page);
        // The user leaves the camera alone meanwhile; the slot frees, the update runs and lands.
        await request.post(`${base()}/api/test/slot-release`);
        held = false;
        await request.post(`${base()}/api/compute-queue/kick`, { data: { project_id: pid } });
        await awaitLanding(page, before);
        rev += 1;
        await expect.poll(async () => (await linkedOf(request, pid, sid))!.rev, { timeout: 120_000 }).toBe(rev);
        expect((await partMeta(request, pid, gid)).zmax).toBe(round.height);
        // The page closed before its hook returned: the view that landed is the link's.
        const last = (await lastLanding(page))!;
        expect([last.geometryId, last.view, !!last.cameraKept]).toEqual([gid, true, false]);
        const landed = await expectSameView(page, cam);
        expect(landed.parallel).toBe(round.cam.projection === 'orthographic');
        await shot(page, `l3-background-camera-${round.cam.projection}`);
      } finally {
        if (held) await request.post(`${base()}/api/test/slot-release`);
      }
    }
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test("cad:l3-vortex-include Daniel's Vortex with a block left out of the simulation: only the Vortex goes to the project; with nothing included the leave says so and goes on", async ({ page, request }) => {
    test.setTimeout(480_000);
    if (REQUIRE && !VORTEX) throw new Error("gate:l3-cad needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step");
    test.skip(!VORTEX, "needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step");
    expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP is set but there is no file at ${VORTEX}`).toBe(true);
    const { seen, pid, sid, frame } = await freshPart(page, request, 'CAD exit Vortex');
    try {
      // The Vortex, by the Import STEP picker; then a block beside it.
      const chooser = page.waitForEvent('filechooser');
      await frame.locator('[data-cad-toolbar] [data-command="file.import-step"]').click();
      await (await chooser).setFiles(VORTEX);
      const panel = frame.locator('[data-cad-panel="feature"]');
      await expect(panel.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
      await expect(panel.locator('[data-import-progress]')).toHaveCount(0);
      await panel.locator('[data-panel-done]').click();
      await expect(panel).toHaveCount(0);
      await settled(page);
      const vortexId = await workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { bodies: { id: string }[] } } } } } } }).__CAD__.services.doc.state.get().rebuild.bodies[0].id);
      const block = await addSolid(page, { at: [400, 0, 0], size: [20, 20, 20] });
      await settled(page);
      // The block left out with its Include toggle.
      const folder = frame.locator('[data-bodies-folder]');
      if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row').click();
      const toggle = (id: string) => frame.locator(`[data-body-row="${id}"] [data-body-act="simulation"]`);
      await toggle(block.body!).click();
      await expect(frame.locator(`[data-body-row="${block.body}"]`)).toHaveAttribute('data-in-simulation', '0');
      await settled(page);

      // Back: only the Vortex goes to the project.
      await backAndLand(page, pid);
      const linked = (await linkedOf(request, pid, sid))!;
      expect(linked.rev).toBe(1);
      const sc = sidecarOf(pid, sid);
      expect(sc.bodies.map((b) => b.id)).toEqual([vortexId]);
      expect(sc.faces.every((f) => f.body === 1)).toBe(true);
      expect((await partMeta(request, pid, linked.geometryId)).faces).toBe(sc.faces.length);
      await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(linked.geometryId);

      // The Vortex left out too: nothing is included. The leave says so in the header and goes on.
      const f2 = await reopen(page);
      const folder2 = f2.locator('[data-bodies-folder]');
      if ((await folder2.getAttribute('aria-expanded')) !== 'true') await folder2.locator('> .tree-row').click();
      await f2.locator(`[data-body-row="${vortexId}"] [data-body-act="simulation"]`).click();
      await settled(page);
      await watchLeaveStatus(page);
      await backButton(page).click();
      await expect(leaveStatus(page)).toHaveText('No body is included in the simulation; Part 1 keeps its last update.', { timeout: 10_000 });
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
      expect(await toastSeen(page)).toEqual([]);
      expect((await linkedOf(request, pid, sid))!.rev).toBe(1);
      await expect.poll(() => behindOf(request, pid, linked.geometryId), { timeout: 30_000 }).toBe(true);
      await landingDialog(page, null);
      expect(seen.csp, 'CSP violations').toEqual([]);
      expect(seen.errors, 'console errors').toEqual([]);
    } finally {
      // Nothing made from Daniel's file is kept (the project and its export go).
      await deleteProject(request, pid);
    }
  });
});
