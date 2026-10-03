// SD pass, review round 2: the polish, one test per finding, in the real host
// frame with the real kernel (the blocker is cad-sd-review2-leave.spec.ts).
//   - part-shrinks: the part shrinks under a side set inwards (−Z −15, then the
//     extrude 20 -> 10 mm): the reason shows under the −Z field (its label level
//     with the input), Bodies counts what it encloses, and the Delete reason of
//     an Enclosure whose body a Combine uses names it once.
//   - one-note: several sides into the part give one note naming them, and Done
//     stays in view at 1280 x 800.
//   - escape-drag: Escape during an Enclosure arrow drag or an Extrude arrow
//     drag puts the value back and keeps the panel open; the Enclosure arrow's
//     value uses the same minus sign as its name.
//   - curved-prompt: Sketch waiting for a face, a curved face clicked: one colon.
// window.__CAD__ is used to project model points to screen pixels and to read
// exact figures the panel rounds.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, modelOnPage, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

type V3 = [number, number, number];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, projectId };
}

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${esc(name)}$`) }) });
const bodyRows = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-body-row]');
const sideField = (frame: FrameLocator, key: string) => panel(frame).locator(`.nui[data-field="side-${key}"] input`);
const sideError = (frame: FrameLocator, key: string) => panel(frame).locator(`.nui[data-field="side-${key}"] [data-nui-error]`);
const notes = (frame: FrameLocator) => panel(frame).locator('[data-side-note]');
const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

type CadWin = {
  __CAD__: {
    services: {
      doc: { state: { get(): { doc: { features: { id: string; type: string; name: string; sides?: Record<string, string>; extent?: { distance: string }; profiles?: { sketch: string; region: string }[]; flip?: boolean }[] }; rebuild: { status: string; bodies: { id: string; name: string; volume: number | null }[]; outputs: Record<string, { type: string; box?: { min: V3; max: V3 }; plane?: { origin: V3; normal: V3; xdir: V3 }; regions?: { key: string; sample: [number, number] }[] }> } } } };
      viewport: { get(): { handle: { pixelSize(p: V3): number; camera(): { position: V3 }; state: { get(): { animating: boolean } } } } };
    };
  };
};

async function setField(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
}

async function settled(page: Page) {
  await expect.poll(() => cad<string>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().rebuild.status) as never)).toBe('done');
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.state.get().animating) as never)).toBe(false);
}

async function openEnclosure(frame: FrameLocator) {
  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText(/^Enclosure \d+$/);
}

async function openFeature(frame: FrameLocator, name: string) {
  await featureRow(frame, name).locator('> .tree-row').dblclick();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText(name);
}

/** The vertical middle of a side's label and of its input (px): level when they are within a few px. */
async function labelAndInput(frame: FrameLocator, key: string): Promise<{ label: number; input: number }> {
  const row = panel(frame).locator(`[data-field-row="side-${key}"]`);
  const l = (await row.locator('.mgk-field-k label').boundingBox())!;
  const i = (await row.locator('.nui input').boundingBox())!;
  return { label: l.y + l.height / 2, input: i.y + i.height / 2 };
}

async function expectLevel(frame: FrameLocator, key: string) {
  const m = await labelAndInput(frame, key);
  expect(Math.abs(m.label - m.input), `${key}: label middle ${m.label}, input middle ${m.input}`).toBeLessThanOrEqual(2);
}

/** The open Enclosure's own value for a side (undefined: it follows the padding). */
const ownSide = (page: Page, side: string) =>
  cad<string | null>(page, ((sd: string) => (window as unknown as CadWin).__CAD__.services.doc.state.get().doc.features.filter((f) => f.type === 'enclosure').pop()?.sides?.[sd] ?? null) as never, side);

/** Where the open Enclosure's box arrow for `side` starts and the way it points (as handles.ts places it). */
async function boxArrow(page: Page, side: string): Promise<{ base: V3; dir: V3 }> {
  return cad(page, ((sd: string) => {
    const st = (window as unknown as CadWin).__CAD__.services.doc.state.get();
    const f = st.doc.features.filter((x) => x.type === 'enclosure').pop()!;
    const o = st.rebuild.outputs[f.id];
    const k = sd[1] === 'x' ? 0 : sd[1] === 'y' ? 1 : 2;
    const plus = sd[0] === '+';
    const base = [0, 1, 2].map((i) => (o.box!.min[i] + o.box!.max[i]) / 2) as V3;
    base[k] = plus ? o.box!.max[k] : o.box!.min[k];
    const dir: V3 = [0, 0, 0];
    dir[k] = plus ? 1 : -1;
    return { base, dir };
  }) as never, side);
}

/** A point on `side`'s arrow shaft, 30 px out from its base, and that point moved `mm` along the arrow. */
async function arrowGrab(page: Page, side: string, mm: number): Promise<[V3, V3]> {
  const { base, dir } = await boxArrow(page, side);
  const px = await cad<number>(page, ((q: V3) => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.pixelSize(q)) as never, base);
  const g: V3 = [base[0] + dir[0] * 30 * px, base[1] + dir[1] * 30 * px, base[2] + dir[2] * 30 * px];
  return [g, [g[0] + dir[0] * mm, g[1] + dir[1] * mm, g[2] + dir[2] * mm]];
}

/** Press on a point, move to another in steps, and run `during` with the button still down. */
async function pressAndMove(page: Page, from: V3, to: V3, during: () => Promise<void>) {
  const a = await modelOnPage(page, from);
  const b = await modelOnPage(page, to);
  await page.mouse.move(a[0], a[1], { steps: 2 });
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a[0] + ((b[0] - a[0]) * i) / 12, a[1] + ((b[1] - a[1]) * i) / 12);
  await page.waitForTimeout(400);
  await during();
  // The rest of the press after Escape: moving on and letting go changes nothing.
  await page.mouse.move(b[0] + 30, b[1] + 30, { steps: 3 });
  await page.mouse.up();
}

// ---------------------------------------------------------------- a side past the part after an edit

test('cad:sd-review2-part-shrinks the part shrinks under a side set inwards: the reason under that field, level with its label; Bodies counts; Delete names the body once', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await openEnclosure(frame);
  const p = panel(frame);
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  await setField(frame, 'side-nz', '-15');
  await expect(notes(frame)).toHaveText('−Z cuts through Body 1: Combine Cut will leave the cut-off part of Body 1 out of the fluid');
  await p.locator('[data-panel-done]').click();

  // The fluid: Combine Cut, the Enclosure the target, Body 1 the tool.
  await tb(frame).locator('[data-command="modify.combine"]').click();
  await p.locator('[data-field="op"] select').selectOption('cut');
  await p.locator('[data-pick-list="targets"]').click();
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await bodyRows(frame).nth(1).locator('.tree-row').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  await bodyRows(frame).nth(0).locator('.tree-row').first().click();
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');

  // The Delete reason names Enclosure 1's body once ("Enclosure 1 of Enclosure 1" before).
  await openFeature(frame, 'Enclosure 1');
  await expect(p.locator('[data-delete-block]')).toHaveText('Delete is off: Combine 1 uses Enclosure 1: delete Combine 1 or change what it uses first');
  await p.locator('[data-panel-done]').click();

  // The part shrinks: Extrude 1 from 20 to 10 mm. −Z (15 mm in from the bottom) is now past its top.
  await openFeature(frame, 'Extrude 1');
  await setField(frame, 'distance', '10');
  await p.locator('[data-panel-done]').click();
  await settled(page);
  await expect(featureRow(frame, 'Enclosure 1')).toHaveAttribute('data-state', 'error');
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'error');

  // Its panel: the reason under −Z (red), not only at the foot; Bodies says what it counts.
  await openFeature(frame, 'Enclosure 1');
  await expect(sideError(frame, 'nz')).toHaveText('−Z would put the enclosure past the part (z ≥ 10 mm)');
  await expect(sideField(frame, 'nz')).toHaveAttribute('aria-invalid', 'true');
  await expect(sideField(frame, 'nz')).toHaveValue('-15');
  await expect(sideError(frame, 'pz')).toHaveCount(0);
  await expect(notes(frame)).toHaveCount(0);
  await expect(p.locator('[data-pick-field="bodies"] [data-pick-empty]')).toHaveText('All solid bodies (1): Body 1');
  // The side's label stays level with its input under the reason.
  await expectLevel(frame, 'nz');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'sd-r2-part-shrinks');
  // −5 fits the thinner part: the reason goes, both rows are ok again.
  await setField(frame, 'side-nz', '-5');
  await expect(sideError(frame, 'nz')).toHaveCount(0);
  await expect(featureRow(frame, 'Enclosure 1')).toHaveAttribute('data-state', 'ok');
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  await expect(notes(frame)).toHaveText('−Z cuts through Body 1: Combine Cut will leave the cut-off part of Body 1 out of the fluid');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- one note for the sides into the part

test('cad:sd-review2-one-note sides into the part get one note naming them; Done stays in view at 1280 x 800; a label stays level with its input under a reason', async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { at: [0, 0, 0], size: [40, 40, 40] });
  await addSolid(page, { at: [60, 0, 0], size: [20, 20, 20] });
  await openEnclosure(frame);
  const p = panel(frame);
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  for (const k of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) await setField(frame, `side-${k}`, '-2');
  await expect(notes(frame)).toHaveCount(1);
  await expect(notes(frame)).toHaveAttribute('data-side-note', 'px nx py ny pz nz');
  await expect(notes(frame)).toHaveText('+X, −X, +Y, −Y, +Z and −Z cut through the enclosed bodies: Combine Cut will leave the cut-off parts of the enclosed bodies out of the fluid');
  await expect(p.locator('[data-panel-done]')).toBeInViewport({ ratio: 1 });
  await shot(page, 'sd-r2-one-note');
  // A refused value: the reason under −X, and its label level with the input (it was centred on both).
  await setField(frame, 'side-nx', '-90');
  await expect(sideError(frame, 'nx')).toHaveText('−X would put the enclosure past the part (x ≥ 80 mm)');
  await expectLevel(frame, 'nx');
  // A cylinder's Radius and Bottom too.
  await sideField(frame, 'nx').press('Escape');
  await p.locator('[data-field="shape"] select').selectOption('cylinder');
  await setField(frame, 'side-radius', '-200');
  await expect(sideError(frame, 'radius')).toHaveText("The enclosure has no radius: the Radius side takes away the part's whole radius");
  await expectLevel(frame, 'radius');
  await sideField(frame, 'radius').press('Escape');
  await setField(frame, 'side-bottom', '-90');
  await expect(sideError(frame, 'bottom')).toHaveText('Bottom would put the enclosure past the part (z ≥ 40 mm)');
  await expectLevel(frame, 'bottom');
  await shot(page, 'sd-r2-label-level');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- Escape during a drag

/** Where the extrude's arrow stands on: the profile's inside point and the extrude direction (model mm). */
const extrudeAxis = (page: Page) =>
  cad<{ origin: V3; axis: V3 }>(page, (() => {
    const s = (window as unknown as CadWin).__CAD__.services.doc.state.get();
    const ex = s.doc.features.find((f) => f.type === 'extrude')!;
    const out = s.rebuild.outputs[ex.profiles![0].sketch];
    const reg = out.regions!.find((r) => r.key === ex.profiles![0].region)!;
    const pl = out.plane!;
    const n = pl.normal;
    const x = pl.xdir;
    const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    const o = [0, 1, 2].map((i) => pl.origin[i] + reg.sample[0] * x[i] + reg.sample[1] * y[i]);
    return { origin: o as V3, axis: (ex.flip ? n.map((v) => -v) : n) as V3 };
  }) as never);

test('cad:sd-review2-escape-drag Escape during an Enclosure or Extrude arrow drag puts the value back and keeps the panel open; the arrow value has one minus sign', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  await openEnclosure(frame);
  const p = panel(frame);
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  await setField(frame, 'side-px', '4');
  await settled(page);
  const label = frame.locator('[data-enclosure-value]');

  // +X (4 mm, set on its own) dragged out, Escape with the button down: 4 mm again, the panel open.
  const [g1, e1] = await arrowGrab(page, '+x', 12);
  await pressAndMove(page, g1, e1, async () => {
    await expect(label).toHaveText(/^\+X 1[56](\.\d+)? mm$/);
    await expect.poll(() => ownSide(page, '+x')).not.toBe('4 mm');
    await page.keyboard.press('Escape');
    await expect(label).toBeHidden();
  });
  await settled(page);
  await expect(p.locator('[data-panel-title]')).toHaveText('Enclosure 1');
  expect(await ownSide(page, '+x')).toBe('4 mm');
  await expect(sideField(frame, 'px')).toHaveValue('4');

  // −X (following the padding) dragged in: its value reads "−X −…", then Escape: it follows the padding again.
  const [g2, e2] = await arrowGrab(page, '-x', -15);
  await pressAndMove(page, g2, e2, async () => {
    await expect(label).toHaveText(/^−X −\d+(\.\d+)? mm$/);
    await expect.poll(() => ownSide(page, '-x')).not.toBeNull();
    await page.keyboard.press('Escape');
  });
  await settled(page);
  await expect(p.locator('[data-panel-title]')).toHaveText('Enclosure 1');
  expect(await ownSide(page, '-x')).toBeNull();
  await expect(p.locator('.cad-enclosure-side[data-side="-x"]')).toHaveAttribute('data-side-source', 'padding');
  // With no drag, Escape closes the panel as before.
  await page.keyboard.press('Escape');
  await expect(p).toHaveCount(0);

  // Extrude 1's arrow (20 mm) dragged up, Escape: 20 mm again, its panel open.
  await openFeature(frame, 'Extrude 1');
  await settled(page);
  const { origin, axis } = await extrudeAxis(page);
  const along = (t: number): V3 => [origin[0] + axis[0] * t, origin[1] + axis[1] * t, origin[2] + axis[2] * t];
  const epx = await cad<number>(page, ((q: V3) => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.pixelSize(q)) as never, along(20));
  await pressAndMove(page, along(20 + 20 * epx), along(32 + 20 * epx), async () => {
    await expect(frame.locator('[data-extrude-value]')).toBeVisible();
    await expect.poll(() => cad<string>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().doc.features.find((f) => f.type === 'extrude')!.extent!.distance) as never)).not.toBe('20 mm');
    await page.keyboard.press('Escape');
  });
  await settled(page);
  await expect(p.locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(p.locator('.nui[data-field="distance"] input')).toHaveValue('20');
  await p.locator('[data-panel-done]').click();
  expect(await cad<string>(page, (() => (window as unknown as CadWin).__CAD__.services.doc.state.get().doc.features.find((f) => f.type === 'extrude')!.extent!.distance) as never)).toBe('20 mm');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- the curved-face prompt

test('cad:sd-review2-curved-prompt Sketch waiting for a face: a curved face clicked says so with one colon', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { circle: true, size: [20, 20] });
  await tb(frame).locator('[data-command="view.iso"]').click();
  await settled(page);
  await tb(frame).locator('[data-command="sketch.new"]').click();
  const prompt = frame.locator('[data-sketch-pick]');
  await expect(prompt).toHaveText('Select a plane or a flat face for the sketch (Esc stops)');
  // A point of the cylinder's side facing the camera.
  const cam = await cad<{ position: V3 }>(page, (() => (window as unknown as CadWin).__CAD__.services.viewport.get().handle.camera()) as never);
  const len = Math.hypot(cam.position[0], cam.position[1]);
  const onSide = await modelOnPage(page, [(10 * cam.position[0]) / len, (10 * cam.position[1]) / len, 10]);
  await page.mouse.click(onSide[0], onSide[1]);
  await expect(prompt).toHaveText('That face is curved: pick a plane or a flat face for the sketch (Esc stops)');
  await expect(prompt).toHaveAttribute('data-problem', '1');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
