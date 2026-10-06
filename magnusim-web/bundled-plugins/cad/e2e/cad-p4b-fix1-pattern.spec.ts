// P4b fix round 1, PATTERN: one test per finding of the pattern review (B1, B2, P1-P4, P6), each
// as a user meets it, asserting what the user sees: body rows, the panel's words and its fields,
// the tree's selection, the volume and size chips (analytic values), the failure and note words.
// Setup (blocks, holes) through the document, as the other specs do.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, chipVolumes, featureRowNamed, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

async function settled(page: Page) {
  await expect
    .poll(() =>
      workspaceFrame(page).evaluate(() => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
      }),
    )
    .toBe(true);
}

async function expectVolumes(frame: FrameLocator, want: number[], rel = 1e-6) {
  const sorted = [...want].sort((a, b) => a - b);
  await expect
    .poll(
      async () => {
        const got = (await chipVolumes(frame)).sort((a, b) => a - b);
        return got.length === sorted.length && got.every((g, i) => Math.abs(g / sorted[i] - 1) < rel) ? 'ok' : got.join(', ');
      },
      { timeout: 30_000 },
    )
    .toBe('ok');
}

async function expectSize(frame: FrameLocator, want: number[], tol = 1e-6) {
  await expect
    .poll(async () => {
      const raw = (await frame.locator('[data-chip="size"] [data-size-mm]').getAttribute('data-size-mm').catch(() => null)) ?? '';
      const got = raw.split(',').map(Number);
      return got.length === 3 && got.every((g, i) => Math.abs(g - want[i]) < tol) ? 'ok' : raw;
    }, { timeout: 30_000 })
    .toBe('ok');
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const foot = (frame: FrameLocator) => panel(frame).locator('[data-run-reason] .mgk-reason-msg');
const warning = (frame: FrameLocator) => panel(frame).locator('[data-warning]');
const words = (frame: FrameLocator) => panel(frame).locator('[data-instance-words]');
const marker = (frame: FrameLocator, key: string) => frame.locator(`.cad-pattern-markers [data-pattern-marker="${key}"]`);
const done = async (frame: FrameLocator) => {
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
};

async function selectRow(frame: FrameLocator, name: string) {
  const row = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(?:[(]-[)] )?${name}$`) }) });
  await row.locator('> .tree-row').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
}
const originRow = (frame: FrameLocator, ref: string) => frame.locator(`[data-tree-node="${ref}"] > .tree-row`);

async function typeIn(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel(frame).locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

async function clickAt(page: Page, p: V3) {
  let last = '';
  await expect
    .poll(async () => {
      const moving = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true);
      const at = moving ? 'moving' : (await modelOnPage(page, p)).map((v) => v.toFixed(1)).join(',');
      const same = at !== 'moving' && at === last;
      last = at;
      return same;
    }, { intervals: [150] })
    .toBe(true);
  const [x, y] = await modelOnPage(page, p);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

const HOLE = (r: number, h: number) => Math.PI * r * r * h;

/** A 100 x 40 x 10 plate, a d6 hole at (10, 10) (Extrude 2), and Linear pattern 1 of it along X, count 4, 20 mm. */
async function plateWithPattern(page: Page, frame: FrameLocator) {
  await addSolid(page, { size: [100, 40, 10] });
  await addSolid(page, { circle: true, at: [10, 10, 0], size: [6, 10], op: 'cut' });
  await settled(page);
  await page.keyboard.press('Escape');
  await selectRow(frame, 'Extrude 2');
  await runCommand(frame, 'pattern.linear');
  await originRow(frame, 'origin:x').click();
  await expect(panel(frame).locator('[data-pick-field="dir1"] [data-pick-row]')).toHaveText(/X axis/);
  await typeIn(frame, 'dir1-count', '4');
  await typeIn(frame, 'dir1-distance', '20');
  await settled(page);
}

test.describe('P4b fix round 1: patterns', () => {
  test('cad:p4b-fix1-circular-360 B1: Angle 360° spreads 4 cubes evenly (60 x 60 mm, no copy on the original), the panel says so; a symmetric spread that wraps is red with the reason', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { at: [20, -5, 0], size: [10, 10, 10] });
    await settled(page);
    await page.keyboard.press('Escape');
    await runCommand(frame, 'pattern.circular');
    await panel(frame).locator('[data-field="of"] select').selectOption('bodies');
    await clickAt(page, [25, 0, 10]);
    await expect(panel(frame).locator('[data-pick-field="bodies"] [data-pick-row]')).toHaveCount(1);
    await originRow(frame, 'origin:z').click();
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row]')).toHaveText(/Z axis/);
    await typeIn(frame, 'count', '4');
    await panel(frame).locator('[data-field="mode"] select').selectOption('angle');
    await typeIn(frame, 'angle', '360');
    await settled(page);
    await expect(panel(frame).locator('[data-angle-words]')).toHaveText('360°: the copies are spread evenly all round, as Full 360° spreads them');
    await expect(frame.locator('[data-cad-tree] [data-body-row]')).toHaveCount(4);
    await expect(featureRowNamed(frame, 'Circular pattern 1')).toHaveAttribute('data-state', 'ok');
    await done(frame);
    await page.keyboard.press('Escape');
    await expectVolumes(frame, [1000, 1000, 1000, 1000]);
    // 90° apart: together they span 60 x 60 mm (a copy on the original would leave 50 x 50 or less).
    await expectSize(frame, [60, 60, 10]);
    // Symmetric, 3 per side over 180° each way: instance −3 would sit on instance 3.
    await featureRowNamed(frame, 'Circular pattern 1').locator('> .tree-row').dblclick();
    await typeIn(frame, 'count', '3');
    await typeIn(frame, 'angle', '180');
    await panel(frame).locator('input[data-field="symmetric"]').check();
    await settled(page);
    await expect(foot(frame)).toHaveText('Circular pattern 1 failed: Instance −3 lands on instance 3 (a whole turn from it): lower the Angle or the Count, or use Full 360°');
    await expect(frame.locator('[data-cad-tree] [data-body-row]')).toHaveCount(1);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-fix1-landed-cut B1: a copy of a hole that lands in another hole says so ("lands where no material is left"), not "misses every body"', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [100, 40, 10] });
    await addSolid(page, { circle: true, at: [10, 10, 0], size: [6, 10], op: 'cut' });
    await addSolid(page, { circle: true, at: [30, 10, 0], size: [6, 10], op: 'cut' });
    await settled(page);
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Extrude 2');
    await runCommand(frame, 'pattern.linear');
    await originRow(frame, 'origin:x').click();
    await typeIn(frame, 'dir1-count', '2');
    await typeIn(frame, 'dir1-distance', '20');
    await settled(page);
    // Its only copy lands in Extrude 3's hole: nothing to cut, said as it is (it was "overlaps no body").
    await expect(foot(frame)).toHaveText('Linear pattern 1 failed: Nothing to cut: every copy of Extrude 2 lands where no material is left (already cut away)');
    // Count 3: instance 3 (x = 50) cuts; instance 2 is the amber note (it was "misses every body").
    await typeIn(frame, 'dir1-count', '3');
    await settled(page);
    await expect(warning(frame)).toHaveText('Instance 2 of Extrude 2 lands where no material is left (already cut away): nothing more is cut there');
    await expect(panel(frame)).not.toContainText('misses every body');
    await expectVolumes(frame, [100 * 40 * 10 - 3 * HOLE(3, 10)]);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-fix1-skips-kept B2: skipped instances stay skipped when direction 2 is added and removed', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await plateWithPattern(page, frame);
    const plate = 100 * 40 * 10;
    const hole = HOLE(3, 10);
    await marker(frame, '2').click();
    await marker(frame, '4').click();
    await settled(page);
    await expect(words(frame)).toHaveText('4 instances: the original and 3 copies, 2 skipped');
    await expectVolumes(frame, [plate - 2 * hole]);
    await panel(frame).locator('[data-add-direction="2"]').click();
    await originRow(frame, 'origin:y').click();
    await expect(panel(frame).locator('[data-pick-field="dir2"] [data-pick-row]')).toHaveText(/Y axis/);
    await settled(page);
    // 4 x 2: the original and 7 copies, instances 2 and 4 of the first row still skipped: 6 holes.
    await expect(words(frame)).toHaveText('8 instances: the original and 7 copies, 2 skipped');
    await expectVolumes(frame, [plate - 6 * hole]);
    await expect(marker(frame, '2')).toHaveAttribute('aria-pressed', 'true');
    await panel(frame).locator('[data-remove-direction="2"]').click();
    await settled(page);
    await expect(words(frame)).toHaveText('4 instances: the original and 3 copies, 2 skipped');
    await expectVolumes(frame, [plate - 2 * hole]);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-fix1-body-names P1: copies made as new bodies by a mirror of a pattern have names of their own', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await plateWithPattern(page, frame);
    await typeIn(frame, 'dir1-count', '3');
    await settled(page);
    await done(frame);
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Linear pattern 1');
    await runCommand(frame, 'pattern.mirror');
    await originRow(frame, 'origin:front').click();
    await panel(frame).locator('[data-field="op"] select').selectOption('new');
    await settled(page);
    const names = frame.locator('[data-cad-tree] [data-body-row] .tl');
    await expect(names).toHaveCount(3);
    const all = await names.allTextContents();
    expect(new Set(all).size).toBe(3);
    expect(all.slice(1).sort()).toEqual(['Linear pattern 1 (Mirror copy 1)', 'Linear pattern 1 (Mirror copy 2)']);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-fix1-axis-selection P2: an axis row picked for a direction does not stay selected after Done, and Circular pattern then opens with no axis', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await plateWithPattern(page, frame);
    await expect(frame.locator('[data-tree-node="origin:x"]')).not.toHaveAttribute('aria-selected', 'true');
    // Direction 2 picked from the Y axis row, then removed: the Y row is not left selected.
    await panel(frame).locator('[data-add-direction="2"]').click();
    await originRow(frame, 'origin:y').click();
    await expect(panel(frame).locator('[data-pick-field="dir2"] [data-pick-row]')).toHaveText(/Y axis/);
    await panel(frame).locator('[data-remove-direction="2"]').click();
    await settled(page);
    await done(frame);
    await expect(frame.locator('[data-tree-node="origin:x"][aria-selected="true"], [data-tree-node="origin:y"][aria-selected="true"]')).toHaveCount(0);
    await runCommand(frame, 'pattern.circular');
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row]')).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-fix1-fillet-instance P3 + P4: a fillet on instance 3 stays clean when direction 2 is added; skipped or counted away, its failure says why', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await plateWithPattern(page, frame);
    await done(frame);
    await page.keyboard.press('Escape');
    await runCommand(frame, 'modify.fillet');
    await clickAt(page, [50, 7, 10]);
    await expect(panel(frame).locator('[data-pick-row]').first()).toContainText('instance 3');
    await typeIn(frame, 'radius', '1');
    await settled(page);
    await done(frame);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
    // P3: direction 2 added (Y axis): Fillet 1 stays ok, no "Reference repaired".
    await featureRowNamed(frame, 'Linear pattern 1').locator('> .tree-row').dblclick();
    await panel(frame).locator('[data-add-direction="2"]').click();
    await originRow(frame, 'origin:y').click();
    await settled(page);
    await done(frame);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
    // P4: instance 3 skipped by its marker: the fillet's failure names the cause.
    await featureRowNamed(frame, 'Linear pattern 1').locator('> .tree-row').dblclick();
    await marker(frame, '3').click();
    await settled(page);
    await done(frame);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'error');
    await featureRowNamed(frame, 'Fillet 1').locator('> .tree-row').dblclick();
    await expect(foot(frame)).toContainText('not found on Body 1 after rebuild (instance 3 of Linear pattern 1 is skipped)');
    await done(frame);
    // Made again, then a count of 2 along X (2 x 2 with direction 2): "now makes 4 instances".
    await featureRowNamed(frame, 'Linear pattern 1').locator('> .tree-row').dblclick();
    await marker(frame, '3').click();
    await typeIn(frame, 'dir1-count', '2');
    await settled(page);
    await done(frame);
    await featureRowNamed(frame, 'Fillet 1').locator('> .tree-row').dblclick();
    await expect(foot(frame)).toContainText('(Linear pattern 1 now makes 4 instances, so there is no instance 3)');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-fix1-panel-words P6: no cut-off select text, one heading per field ("Direction 1" / "Along"; the axis once)', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await plateWithPattern(page, frame);
    await expect(panel(frame).locator('[data-pick-field="dir1"] .cad-pick-label')).toHaveText('Along');
    await expect(panel(frame).locator('[data-field="dir1-mode"] select option:checked')).toHaveText('Spacing');
    await expect(panel(frame).locator('[data-field="op"] select option:checked')).toHaveText('As each feature');
    await expect(panel(frame).locator('[data-op-words]')).toHaveText("Each feature's own: Cut");
    // Every select's chosen words fit inside it.
    const clipped = await panel(frame)
      .locator('select')
      .evaluateAll((els) =>
        els.flatMap((el) => {
          const s = el as HTMLSelectElement;
          const cs = getComputedStyle(s);
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const text = s.options[s.selectedIndex]?.text ?? '';
          const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16;
          return ctx.measureText(text).width > room ? [text] : [];
        }),
      );
    expect(clipped).toEqual([]);
    await done(frame);
    await runCommand(frame, 'pattern.circular');
    await expect(panel(frame).locator('.cad-field-group-title', { hasText: /^Axis$/ })).toHaveCount(0);
    await expect(panel(frame).locator('[data-pick-field="axis"] .cad-pick-label')).toHaveText('Axis');
    expect(seen.errors).toEqual([]);
  });
});
