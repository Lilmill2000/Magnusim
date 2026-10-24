// The Assistant's round trip between the simulation and CAD (core host tools spec 0.4, 5.1, 16.3:
// G11, G13), as the person sees it, from the dock in the project's workbench:
//   1. setup_edit edit_in_cad on the imported box: the Part that edits it is made (its row in the
//      tree), and the window still shows the workbench;
//   2. core__show workspace: the Part opens over the workbench, titled with the geometry's name,
//      importing the box by itself, and the dock's context chip says the Part offers its tools;
//   3. cad__direct press-pull: the box's top moves up 5 mm in the Part;
//   4. core__show project (Back): the dock asks first, as a computation ("Allow the Assistant to
//      send your design to the simulation?"); after Allow the window is the workbench again, the
//      app asks how to update the geometry (the person's Overwrite), and the geometry is the box
//      5 mm taller, the same row in the tree, its BC kept on the top that moved.
//      Back in the workbench, the turn ends with no review round of the Part it left.
// A Don't on that card leaves the person in the Part with nothing sent.
// Two bugs this found: the send card read "Allow the Assistant to move this window?" with the
// note as its copy (the runner's assessment kept only the risk, note and rows, so the page's own
// title and copy were lost), and a turn that had left the Part still got the Part's review round
// ("Checking its work") in the workbench.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
import { cadPreviewReady } from '../../../e2e/support/cad-preview.mjs';
import { chats, newProject, resetAssistant, resultsIn, startAssistantHost, STEP, useScriptedModel, type AssistantHost } from './assistant-helpers';
import { BOX, editOpened } from './edit-in-cad-helpers';
import { answerLinkQuestion, geometryRow } from './helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-roundtrip', 130);
  await useScriptedModel(request, host, 'cloud');
});

test.afterAll(async () => {
  if (host) await host.stop();
});

test.beforeEach(async ({ request, page }) => {
  await resetAssistant(request, host);
  await useScriptedModel(request, host, 'cloud');
  await page.setViewportSize({ width: 1400, height: 900 });
});

test.afterEach(() => {
  expect(host.fake.pending(), 'scripted answers left unused').toBe(0);
});

const SEND_TITLE = 'Allow the Assistant to send your design to the simulation?';
const SETUP = (o: Record<string, unknown>) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });
const SHOW = (o: Record<string, unknown>) => ({ name: 'core__show', input: { target: '', project_id: '', id: '', panel: '', ...o } });
const DIRECT = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'press_pull', faces: [], distance: '', bodies: [], tool: '', keep_tool: false, shape: 'box', padding: 'zero', sides: [], ...o });

async function postOk(request: APIRequestContext, path: string, data: Record<string, unknown>) {
  const r = await request.post(`${host.base}${path}`, { data, timeout: 600_000 });
  const j = await r.json();
  expect(r.ok(), `${path}: ${JSON.stringify(j)}`).toBe(true);
  return j;
}

/** The box imported in the simulation view, a study on it with a wall on its top face: {gid, name, sid, topFace}. */
async function boxProject(request: APIRequestContext, title: string) {
  const pid = await newProject(request, host, title);
  const g = (await postOk(request, '/api/geometry/import', { project_id: pid, step_path: BOX, filename: 'box20.step' })).geometry;
  const m = await meta(request, pid, String(g.id));
  const top = m.faces.find((f) => f.normal && Math.abs(f.normal[2] - 1) < 1e-6);
  expect(top, 'the top face').toBeTruthy();
  const sim = (await postOk(request, '/api/simulation', { project_id: pid, geometry_id: g.id })).simulation;
  await postOk(request, '/api/bcs', { project_id: pid, simulation_id: sim.id, name: 'Lid', bc_type: 'Wall', faces: [`face ${top!.id}`] });
  return { pid, gid: String(g.id), name: String(g.name), sim: String(sim.id), zmax: m.zmax };
}

type Face = { id: number; normal?: number[] | null; centroid: number[] };
async function meta(request: APIRequestContext, pid: string, gid: string): Promise<{ faces: Face[]; zmax: number }> {
  const r = await cadPreviewReady(request, `${host.base}/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=meta`, 600_000);
  expect(r.ok(), await r.text()).toBe(true);
  const j = await r.json();
  return { faces: j.faces, zmax: Number(j.bounds?.zmax) };
}

async function openWorkbench(page: Page, pid: string) {
  await page.goto(`${host.base}/#/p/${pid}`);
  await page.waitForFunction((id) => (window as unknown as { __CFD_PROJECT_READY__?: string }).__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  await core.openDock(page);
}

const contextChip = (page: Page) => page.locator('#assistant-dock [data-dock-context]');
/** The first body's name in the Part's tree. */
const firstBody = (page: Page) => page.frameLocator('#workspace-frame').locator('[data-cad-tree] [data-body-row] .cad-body-name').first();

test('cad:assistant-roundtrip the AI opens the box in CAD, makes it taller, and sends it back: each step on screen, one compute card for the send, the geometry updated in place', async ({ page, request }) => {
  test.setTimeout(600_000);
  const box = await boxProject(request, 'Round trip');
  await openWorkbench(page, box.pid);
  await expect(contextChip(page)).toHaveAttribute('data-dock-context', 'project');

  let partStudy = '';
  host.fake.reply(
    { text: 'Opening it in CAD.', tools: [{ name: 'setup_edit', input: SETUP({ kind: 'geometry', action: 'edit_in_cad', id: box.gid }) }] },
    async (body: unknown) => {
      const [made] = resultsIn(body);
      expect(made.ok, JSON.stringify(made)).toBe(true);
      partStudy = String(made.data!.ids && (made.data!.ids as Record<string, string>).plugin_study);
      // Made, not opened: the window still shows the workbench.
      await expect(page.locator('#workspace-overlay')).toBeHidden();
      return { tools: [SHOW({ target: 'workspace', id: partStudy })] };
    },
    async () => {
      // The Part is open over the workbench, titled with the geometry, its import done.
      await expect(page.locator('#workspace-overlay [data-ws-title]')).toHaveText(box.name, { timeout: 60_000 });
      await editOpened(page, box.pid);
      await expect(contextChip(page)).toHaveAttribute('data-dock-context', 'tools', STEP);
      const body = ((await firstBody(page).textContent()) ?? '').trim();
      return { tools: [{ name: 'cad__direct', input: DIRECT({ faces: [`${body} faces >Z`], distance: '5 mm' }) }] };
    },
    { tools: [SHOW({ target: 'project' })] },
    { text: 'The taller box is in the simulation.' },
  );
  await core.dockSend(page, 'Make the box 5 mm taller in CAD and send it back.');

  // The send asks first, as a computation.
  const card = core.dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText(SEND_TITLE, { timeout: 180_000 });
  await expect(card).toContainText('Runs a computation');
  await expect(card.locator('.dock-gate-copy')).toContainText('sends its design to this project');
  // Asked while the person is still in the Part, which shows the change.
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  const pressed = chats(host).map((r) => resultsIn(r)[0]).find((x) => x && x.tool === 'cad__direct');
  expect(pressed, 'the press-pull answered').toMatchObject({ ok: true, data: { feature: { type: 'press_pull', state: 'ok' } } });
  await card.locator('[data-gate-answer="yes"]').click(STEP);

  // Back: the app's own question about the geometry (core__show waits for the person meanwhile);
  // the person overwrites it, and the window is the workbench again.
  await answerLinkQuestion(page, 'overwrite');
  await expect(page).toHaveURL(new RegExp(`#/p/${box.pid}$`), { timeout: 120_000 });
  // The app's report on the update, as after the person's own Back.
  await expect(page.locator('#cf-heading')).toHaveText(`${box.name} updated`, { timeout: 120_000 });
  await expect(page.locator('#cf-copy')).toContainText(`${box.name} updated from`);
  await page.locator('#cf-confirm').click();
  await expect(core.dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 120_000 });
  // Back in the workbench, the Part's review rounds are not asked for.
  await expect(core.dockTurn(page)).not.toContainText('Checking its work');
  await expect(contextChip(page)).toHaveAttribute('data-dock-context', 'project', STEP);
  // The same geometry, 5 mm taller, its row in the tree, the wall still on the top that moved.
  await expect(geometryRow(page, box.gid)).toBeVisible(STEP);
  await expect.poll(async () => (await meta(request, box.pid, box.gid)).zmax, { timeout: 120_000 }).toBeCloseTo(box.zmax + 5, 3);
  const after = await meta(request, box.pid, box.gid);
  const bcs = (await (await request.get(`${host.base}/api/bcs?project_id=${box.pid}&simulation_id=${box.sim}`)).json()).boundary_conditions as { name: string; faces: string[] }[];
  const lid = bcs.find((b) => b.name === 'Lid')!;
  const lidFace = after.faces.find((f) => f.id === Number(/\d+/.exec(lid.faces[0])![0]))!;
  expect(lidFace.centroid[2]).toBeCloseTo(box.zmax + 5, 3);
  // The model heard where the window is now.
  const back = chats(host).map((r) => resultsIn(r)[0]).find((x) => x && x.tool === 'core__show' && JSON.stringify(x.data ?? {}).includes('project'));
  expect(back?.ok, JSON.stringify(back)).toBe(true);
});

test("cad:assistant-roundtrip-dont Don't on the send card: the person stays in the Part and nothing goes to the simulation", async ({ page, request }) => {
  test.setTimeout(600_000);
  const box = await boxProject(request, 'Round trip kept');
  await openWorkbench(page, box.pid);
  let partStudy = '';
  host.fake.reply(
    { tools: [{ name: 'setup_edit', input: SETUP({ kind: 'geometry', action: 'edit_in_cad', id: box.gid }) }] },
    (body: unknown) => {
      partStudy = String((resultsIn(body)[0].data!.ids as Record<string, string>).plugin_study);
      return { tools: [SHOW({ target: 'workspace', id: partStudy })] };
    },
    async () => {
      await editOpened(page, box.pid);
      const body = ((await firstBody(page).textContent()) ?? '').trim();
      return { tools: [{ name: 'cad__direct', input: DIRECT({ faces: [`${body} faces >Z`], distance: '5 mm' }) }] };
    },
    { tools: [SHOW({ target: 'project' })] },
    { text: 'Left it in CAD.' },
    // Still in the Part after its own edit: the Part's review round, which finds nothing to change.
    { text: 'Review: no changes' },
  );
  await core.dockSend(page, 'Make it taller and send it.');
  const card = core.dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText(SEND_TITLE, { timeout: 180_000 });
  await card.locator('[data-gate-answer="no"]').click();
  await expect(core.dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
  await expect(core.dockTurn(page)).toContainText('Left it in CAD.');
  // Still in the Part; no question about the geometry; the geometry as it was.
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  await expect(page.locator('#modal-link-choice')).toBeHidden();
  expect((await meta(request, box.pid, box.gid)).zmax).toBeCloseTo(box.zmax, 3);
  const declined = chats(host).map((r) => resultsIn(r)[0]).find((x) => x && x.tool === 'core__show' && x.ok === false);
  expect(declined?.error?.code).toBe('declined');
});

// The send card names what the person is sending to and what it touches (spec 14.2): "Leaves the
// CAD Part "<name>" and sends its design to project <project>: it updates geometry "<name>" (N
// studies use it)." Today the card says the plugin's and workspace's names only (lane G1 adds the
// geometry's name and its study count).
test.fixme("cad:assistant-roundtrip-card the send card names the geometry it updates and how many studies use it (G1: leave-CAD card details)", async ({ page, request }) => {
  test.setTimeout(600_000);
  const box = await boxProject(request, 'Round trip card');
  await openWorkbench(page, box.pid);
  host.fake.reply(
    { tools: [{ name: 'setup_edit', input: SETUP({ kind: 'geometry', action: 'edit_in_cad', id: box.gid }) }] },
    (body: unknown) => ({ tools: [SHOW({ target: 'workspace', id: String((resultsIn(body)[0].data!.ids as Record<string, string>).plugin_study) })] }),
    async () => {
      await editOpened(page, box.pid);
      const body = ((await firstBody(page).textContent()) ?? '').trim();
      return { tools: [{ name: 'cad__direct', input: DIRECT({ faces: [`${body} faces >Z`], distance: '5 mm' }) }] };
    },
    { tools: [SHOW({ target: 'project' })] },
    { text: 'Left it.' },
    { text: 'Review: no changes' },
  );
  await core.dockSend(page, 'Make it taller and send it.');
  const card = core.dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText(SEND_TITLE, { timeout: 180_000 });
  await expect(card.locator('.dock-gate-copy')).toContainText(`updates geometry "${box.name}" (1 study uses it)`);
  await card.locator('[data-gate-answer="no"]').click();
  await expect(core.dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
});

