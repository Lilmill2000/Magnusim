// INSPECT's Check for an assembly, as the person uses it (the person's side of the Assistant's
// check tool), each on a fresh Part whose bodies go in through the document as the other specs do:
//   cad:check-loose        a shaft (a head and a rod) and a wheel resting on its head with nothing
//                          above it: Check, Loose parts, Check: the line names the wheel and +Z,
//                          and the wheel's finding says it can slide off toward +Z, and a click
//                          on it selects the wheel; a collar pressed on above it: Check (open
//                          again in Loose parts) says nothing is loose;
//   cad:check-interference two blocks that overlap: Interference lists the pair with its 4000 mm³,
//                          and clicking the row selects both bodies;
//   cad:check-rotation     an arm on a pin with a post in its way: Rotation with the arm turning
//                          about the axis it shares with the pin gives the angle it meets the post
//                          at (24.41 degrees), naming the post.
// Owner: ASSISTANT (the person's side of check).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function freshPart(page: Page, request: APIRequestContext): Promise<FrameLocator> {
  await watchPage(page);
  const projectId = await newProject(request, `CAD check ${Date.now()}`);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return frame;
}

/** Names the newest body `name` (the tree's rename, through the document); returns its id. */
async function nameNewest(page: Page, name: string): Promise<string> {
  return workspaceFrame(page).evaluate((n) => {
    const doc = (window as unknown as W).__CAD__.services.doc;
    const bodies = doc.state.get().rebuild.bodies;
    const id = bodies[bodies.length - 1].id as string;
    doc.renameBody(id, n);
    return id;
  }, name);
}

const selectedBodies = (page: Page) =>
  workspaceFrame(page).evaluate(() =>
    (window as unknown as W).__CAD__.services.selection
      .get()
      .items.filter((it: { kind: string }) => it.kind === 'body')
      .map((it: { body: string }) => it.body),
  );

const panelOf = (frame: FrameLocator) => frame.locator('[data-tool-panel="inspect.check"]');

/** INSPECT's Check, then the mode's button. */
async function openCheck(frame: FrameLocator, mode: 'interference' | 'stack' | 'sweep') {
  await runCommand(frame, 'inspect.check');
  await expect(panelOf(frame)).toBeVisible();
  await panelOf(frame).locator(`[data-check-mode-button="${mode}"]`).click();
  await expect(panelOf(frame)).toHaveAttribute('data-check-mode', mode);
}

/** Check pressed, and its result in. */
async function runCheck(frame: FrameLocator, kind: string) {
  const run = panelOf(frame).locator(`[data-check-run="${kind}"]`);
  await expect(run).not.toHaveAttribute('data-disabled-reason', /.+/);
  await run.click();
  await expect(panelOf(frame).locator('[data-check-progress]')).toHaveCount(0, { timeout: 120_000 });
  return panelOf(frame).locator(`[data-check-result="${kind}"]`);
}

test('cad:check-loose Loose parts names the wheel that can slide off its shaft toward +Z; after a collar, nothing is loose', async ({ page, request }) => {
  test.setTimeout(300_000);
  const frame = await freshPart(page, request);
  // A shaft: a head 12 across and 2 thick, and a rod 4 across and 30 long joined to it.
  await addSolid(page, { circle: true, size: [12, 2] });
  const shaft = await nameNewest(page, 'Shaft');
  await addSolid(page, { circle: true, size: [4, 30], op: 'join', scope: [shaft] });
  // A wheel 30 across and 4 thick with a 4.4 bore, resting on the head.
  await addSolid(page, { circle: true, at: [0, 0, 2], size: [30, 4] });
  const wheel = await nameNewest(page, 'Wheel');
  await addSolid(page, { circle: true, at: [0, 0, 2], size: [4.4, 4], op: 'cut', scope: [wheel] });

  await openCheck(frame, 'stack');
  const result = await runCheck(frame, 'stack');
  await expect(result.locator('[data-check-text]')).toHaveText('1 part can slide along its shaft: Wheel (+Z)');
  const loose = result.locator('[data-check-loose]');
  await expect(loose).toHaveCount(1);
  await expect(loose).toHaveAttribute('data-check-loose', 'Wheel');
  await expect(loose).toHaveAttribute('data-check-side', '+Z');
  await expect(loose).toHaveText('Wheel can slide along Shaft toward +Z: nothing stops it before it comes off Shaft');
  // The parts in order, and what holds the wheel on each side.
  await expect(result.locator('[data-check-part]')).toHaveText([/^Shaft/, /^Wheelon Shaft, play 0\.2 mmShaft, 0 mmnothing: it comes off$/]);
  // A click on the finding selects the wheel.
  await loose.click();
  await expect.poll(() => selectedBodies(page)).toEqual([wheel]);
  await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.selection.set((s: object) => ({ ...s, items: [] })));

  // A collar 10 across and 3 thick pressed on the rod above the wheel (its bore the rod's size).
  await addSolid(page, { circle: true, at: [0, 0, 6], size: [10, 3] });
  const collar = await nameNewest(page, 'Collar');
  await addSolid(page, { circle: true, at: [0, 0, 6], size: [4, 3], op: 'cut', scope: [collar] });
  // Sketching closed the panel; Check opens again in Loose parts, as it was left.
  await expect(panelOf(frame)).toHaveCount(0);
  await runCommand(frame, 'inspect.check');
  await expect(panelOf(frame)).toHaveAttribute('data-check-mode', 'stack');
  const again = await runCheck(frame, 'stack');
  await expect(again.locator('[data-check-text]')).toHaveText('Nothing is loose: 1 part on 1 axis, each held both ways within 0.5 mm');
  await expect(again.locator('[data-check-loose]')).toHaveCount(0);
  await expect(again.locator('[data-check-stale]')).toHaveCount(0);
  await expect(again.locator('[data-check-part="Wheel"]')).toHaveText('Wheelon Shaft, play 0.2 mmShaft, 0 mmCollar, 0 mm');
});

test('cad:check-interference Interference lists two overlapping blocks with their 4000 mm³; clicking the row selects both', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  const a = await nameNewest(page, 'Block A');
  await addSolid(page, { at: [10, 0, 0], size: [20, 20, 20] });
  const b = await nameNewest(page, 'Block B');
  await openCheck(frame, 'interference');
  await expect(panelOf(frame).locator('[data-check-scope]')).toHaveText('Checks every shown body (2)');
  const result = await runCheck(frame, 'interference');
  await expect(result.locator('[data-check-text]')).toHaveText('1 pair overlaps (2 bodies, 1 of 1 pairs near enough to measure): Block A and Block B 4000 mm3');
  const row = result.locator('[data-check-pair="Block A|Block B"]');
  await expect(row).toHaveText('Block A and Block B4000 mm³ overlap');
  await row.click();
  await expect.poll(() => selectedBodies(page)).toEqual([a, b]);
  await expect(panelOf(frame).locator('[data-check-scope]')).toHaveText('Checks the 2 selected bodies');
});

test('cad:check-rotation Rotation turns an arm about the axis it shares with its pin: it meets the post at 24.41 degrees', async ({ page, request }) => {
  test.setTimeout(300_000);
  const frame = await freshPart(page, request);
  // A pin 2 across along Z, from z -3 to 7.
  await addSolid(page, { circle: true, at: [0, 0, -3], size: [2, 10] });
  await nameNewest(page, 'Pin');
  // An arm: a hub 8 across and 3 thick with a bar 30 long and 3 wide along +X, a 2.4 bore.
  await addSolid(page, { circle: true, size: [8, 3] });
  const arm = await nameNewest(page, 'Arm');
  await addSolid(page, { at: [0, -1.5, 0], size: [30, 3, 3], op: 'join', scope: [arm] });
  await addSolid(page, { circle: true, size: [2.4, 3], op: 'cut', scope: [arm] });
  // A post in the arm's way, x 10..14, y 8..12.
  await addSolid(page, { at: [10, 8, 0], size: [4, 4, 3] });
  await nameNewest(page, 'Post');

  await openCheck(frame, 'sweep');
  const panel = panelOf(frame);
  await panel.locator('[data-check-turning] select').selectOption({ label: 'Arm' });
  // The axis the arm shares with the pin, found from their round faces.
  const axis = panel.locator('[data-check-axis-pick] select');
  await expect(axis.locator('option:checked')).toHaveText('along Z through (0, 0, 0): shared with Pin');
  const result = await runCheck(frame, 'sweep');
  await expect(result.locator('[data-check-text]')).toHaveText(/^Arm turned along Z through \(0, 0, 0\) hits Post at 24\.40\d* deg \(\d+(\.\d+)? deg the other way\)$/);
  const hit = result.locator('[data-check-hit="Post"]');
  await expect(hit).toHaveCount(1);
  await expect(hit.locator('td').nth(0)).toHaveText('Arm');
  await expect(hit.locator('td').nth(1)).toHaveText('Post');
  await expect(hit.locator('td').nth(2)).toHaveText(/^24\.4\d*°$/);
  const want = (Math.atan2(8, 14) - Math.asin(1.5 / Math.hypot(14, 8))) * (180 / Math.PI);
  expect(Number(await hit.getAttribute('data-check-first-deg'))).toBeCloseTo(want, 2);
});
