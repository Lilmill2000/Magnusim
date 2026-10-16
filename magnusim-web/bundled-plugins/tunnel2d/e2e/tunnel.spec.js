// The 2D Wind Tunnel as the user meets it (T1).
//
// 1. A new tunnel opens on its default scene (NACA 2412 at 6° in 10 m/s of air) and the
//    flow runs on the GPU: the status line counts steps and simulated time, the vorticity
//    field around the airfoil grows, and the Reynolds numbers say honestly what is run: the
//    turbulence model at the real one, or (resolved) the lower one the grid simulates.
// 2. Dragging the airfoil with the mouse moves it in the flow (the flow's body catches up
//    with the dragged pose), the wake follows it, and the new position is saved: after a
//    reload the airfoil is where it was left.
// 3. The turn handle sets the angle of attack; the body panel edits the NACA designation
//    (a bad one is refused with the reason); bodies are added, removed and brought back
//    with Undo; the field picker shows speed and pressure with a legend in their units.
// 4. The plugin's own solver passes the Schäfer–Turek 2D-2 cylinder benchmark (St, Cd).
// 5. A short drag soak: dragging and turning bodies for 30 s (10 min with
//    MAGNUSIM_E2E_SOAK=1) never makes the flow unstable.
// 6. A body dragged into another (the closing gap's flow is limited, and the page says so)
//    leaves the flow stable; a fast drag leaves no sound waves ringing (the diamond
//    artefacts); the rheoscopic view keeps a sound flake field.
// 7. Without WebGPU (no navigator.gpu, or no adapter), the page says why it cannot run.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { e2eTemp, NO_GEOMETRY_PROJECT, startHost } from '../../../e2e/support/plugin-suite.js';

const KEY = 'tunnel2d';
const KIND = 'tunnel';
const PROJECT = NO_GEOMETRY_PROJECT;
const SOAK_MS = process.env.MAGNUSIM_E2E_SOAK === '1' ? 600_000 : 30_000;

let host;
/** Why this browser cannot run the flow (no WebGPU adapter, not even the software one), or ''. */
let noGpu = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  const tmp = e2eTemp(KEY);
  host = await startHost({ name: KEY, tmp, enablePlugins: [KEY], viteCacheDir: join(tmp, 'vite-cache') });
  const page = await browser.newPage();
  await page.goto(`${host.base}/api/registry`);
  const adapter = await page.evaluate(async () => {
    const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    if (!a) return null;
    const i = a.info ?? {};
    return { software: !!i.isFallbackAdapter || /swiftshader/i.test(`${i.vendor} ${i.architecture} ${i.description}`) };
  });
  await page.close();
  if (!adapter) noGpu = "this browser offers no WebGPU adapter (not even Chrome's software one), so the flow cannot run here";
  else if (adapter.software) slowGpu = 'only the software WebGPU adapter (SwiftShader) is here: it runs the flow about a thousand times slower than a GPU, so this test runs where there is one (it does on every local run)';
});

/** Why the flow cannot run fast enough here for a test that needs it, or ''. */
let slowGpu = '';
/** Tests that only drive the page skip only where there is no WebGPU at all. */
const needsGpu = () => test.skip(!!noGpu, noGpu);
/** Tests that need the flow to develop (wakes, forces, the benchmark) skip on a software adapter too. */
const needsFastGpu = () => test.skip(!!(noGpu || slowGpu), noGpu || slowGpu);

test.afterAll(() => host?.stop());
// On the software adapter (CI) the page starts and draws far slower: every test that runs
// there takes three times its time, and the page up to four minutes to be ready.
const SOFTWARE = process.env.MAGNUSIM_E2E_WEBGPU === 'swiftshader' || (!!process.env.CI && process.env.MAGNUSIM_E2E_WEBGPU !== 'gpu');
test.beforeEach(() => {
  if (slowGpu) test.slow();
});

async function newTunnel(request, title) {
  const made = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: PROJECT, plugin: KEY, kind: KIND, title } });
  expect(made.ok(), await made.text()).toBe(true);
  return (await made.json()).study;
}

/** Open a tunnel and wait for its page to run; returns the frame. */
async function openTunnel(page, study) {
  await page.goto(`${host.base}/#/p/${PROJECT}/ws/${KEY}/${KIND}/${study.id}`);
  await expect(page.locator('#workspace-overlay')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toContainText(study.title, { timeout: 60_000 });
  let frame = null;
  await expect.poll(() => (frame = page.frames().find((f) => f.url().includes(`/plugins/${KEY}/`))) && true, { timeout: 60_000 }).toBe(true);
  await expect.poll(() => frame.evaluate(() => !!window.__TUNNEL__?.ready).catch(() => false), { timeout: SOFTWARE ? 240_000 : 90_000 }).toBe(true);
  return frame;
}

const T = (frame, fn, arg) => frame.evaluate(fn, arg);
const scene = (frame) => T(frame, () => window.__TUNNEL__.scene());
const stats = (frame) => T(frame, () => window.__TUNNEL__.stats());

/** Frame-internal CSS px -> page px. */
async function pageXY(page, frame, xy) {
  const box = await page.locator('#workspace-frame').boundingBox();
  return { x: box.x + xy.x, y: box.y + xy.y };
}

/** |field| statistics of the sampled field: max, and the x of its weighted centre (cells/4). */
async function fieldStats(frame) {
  return T(frame, async () => {
    // Null while another read is in flight (the colour range reads every 400 ms): try again.
    let s = null;
    for (let t = 0; t < 50 && !s; t++) {
      s = await window.__TUNNEL__.sampleField();
      if (!s) await new Promise((r) => setTimeout(r, 50));
    }
    const st = window.__TUNNEL__.stats();
    const w = Math.ceil(st.nx / 4);
    let max = 0;
    let sx = 0;
    let sw = 0;
    s.forEach((v, i) => {
      if (v == null) return;
      const a = Math.abs(v);
      max = Math.max(max, a);
      if (a > 1) {
        sx += (i % w) * a;
        sw += a;
      }
    });
    return { max, cx: sw ? sx / sw : 0, n: s.length };
  });
}

test('a tunnel runs, the airfoil drags through the flow, and the scene is saved', async ({ page, request }) => {
  needsFastGpu();
  const study = await newTunnel(request, 'Drag test tunnel');
  const frame = await openTunnel(page, study);

  // 1. The default scene and a running flow.
  const s0 = await scene(frame);
  expect(s0.bodies).toHaveLength(1);
  // A new tunnel opens on the flow with particles (speed); this test reads vorticity.
  expect(s0.view.field).toBe('particles');
  await expect(frame.locator('[data-t2d-legend]')).toContainText('Speed');
  await frame.getByRole('combobox', { name: 'Show' }).selectOption('vorticity');
  expect(s0.bodies[0].shape).toMatchObject({ kind: 'naca', code: '2412' });
  const st0 = await stats(frame);
  expect(st0.nx).toBeGreaterThan(100);
  await expect.poll(async () => (await stats(frame)).simTime, { timeout: 30_000 }).toBeGreaterThan(st0.simTime + 0.05);
  await expect(frame.locator('[data-t2d-status]')).toHaveAttribute('data-state', 'running');
  await expect(frame.locator('[data-t2d-status]')).toContainText('cells');
  // The flow grows a boundary layer and a wake: vorticity well above the free stream's zero.
  await expect.poll(async () => (await fieldStats(frame)).max, { timeout: 60_000 }).toBeGreaterThan(5);
  // Re: 10 m/s x 1 m / 1.516e-5 = 660,000 real. The turbulence model runs it (automatic from
  // 100,000) and says what it gives; resolved, the grid simulates far less and says so.
  const re = frame.locator('[data-t2d-re]');
  await expect(re).toBeVisible();
  const real = Number(await re.getAttribute('data-real'));
  expect(real).toBeGreaterThan(6.5e5);
  expect(real).toBeLessThan(6.7e5);
  await expect(re).toHaveAttribute('data-t2d-model', 'sa');
  expect(Number(await re.getAttribute('data-sim'))).toBe(real);
  await expect(re.locator('[data-t2d-model-note="sa"]')).toContainText('Turbulence model on');
  await frame.getByRole('combobox', { name: 'Flow model' }).selectOption('resolved');
  await expect(re).toHaveAttribute('data-t2d-model', 'off');
  expect(Number(await re.getAttribute('data-sim'))).toBeLessThan(real);
  await expect(re).toContainText('simulated at that');
  await frame.getByRole('combobox', { name: 'Flow model' }).selectOption('auto');
  await expect(re).toHaveAttribute('data-t2d-model', 'sa');
  await expect(frame.locator('[data-t2d-legend]')).toContainText('Vorticity');

  // 2. Drag the airfoil 240 px right and 60 px down.
  const body = s0.bodies[0];
  const before = await fieldStats(frame);
  const at = await pageXY(page, frame, await T(frame, ([x, y]) => window.__TUNNEL__.toScreen(x, y), [body.x + 0.15, body.y]));
  const mpp = (await T(frame, () => window.__TUNNEL__.view())).mpp;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(at.x + i * 20, at.y + i * 5);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  const moved = await scene(frame);
  expect(moved.bodies[0].x).toBeCloseTo(body.x + 240 * mpp, 2);
  expect(moved.bodies[0].y).toBeCloseTo(body.y - 60 * mpp, 2);
  // The flow's airfoil reaches the new pose.
  await expect
    .poll(async () => {
      const p = await T(frame, (id) => window.__TUNNEL__.livePose(id), body.id);
      return Math.hypot(p.x - moved.bodies[0].x, p.y - moved.bodies[0].y);
    }, { timeout: 30_000 })
    .toBeLessThan(1e-3);
  // The wake follows: the vorticity's centre moves downstream with the airfoil.
  await expect.poll(async () => (await fieldStats(frame)).cx, { timeout: 30_000 }).toBeGreaterThan(before.cx + 2);
  // Saved, then reopened where it was left.
  await expect.poll(() => T(frame, () => window.__TUNNEL__.save()), { timeout: 15_000 }).toBe('saved');
  await page.reload();
  const again = await openTunnel(page, study);
  const s1 = await scene(again);
  expect(s1.bodies[0].x).toBeCloseTo(moved.bodies[0].x, 6);
  expect(s1.bodies[0].y).toBeCloseTo(moved.bodies[0].y, 6);
});

test('turning, editing, adding and removing bodies, and the field views', async ({ page, request }) => {
  needsGpu();
  const study = await newTunnel(request, 'Edit test tunnel');
  const frame = await openTunnel(page, study);
  const id = (await scene(frame)).bodies[0].id;

  // Select it from the list; the body panel shows its designation.
  await frame.locator(`[data-t2d-body="${id}"]`).click();
  const naca = frame.locator('[data-t2d-text="naca"]');
  await expect(naca).toHaveValue('2412');

  // The turn handle: from straight above the pivot, swing it 10° clockwise with Shift held
  // (whole degrees): the angle of attack goes from 6° to 16°.
  const h = await T(frame, (bid) => window.__TUNNEL__.turnHandle(bid), id);
  const start = await pageXY(page, frame, { x: h.x, y: h.y });
  const pivot = await pageXY(page, frame, { x: h.cx, y: h.cy });
  const R = pivot.y - start.y;
  const a = (80 * Math.PI) / 180;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  for (let k = 1; k <= 5; k++) {
    const t = (Math.PI / 2) * (1 - k / 5) + a * (k / 5);
    await page.mouse.move(pivot.x + R * Math.cos(t), pivot.y - R * Math.sin(t));
  }
  await expect(frame.locator('[data-t2d-hint]')).toContainText('Angle 16.0°');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await scene(frame)).bodies[0].angle).toBe(16);
  // Undo puts the angle back.
  await frame.locator('[data-t2d-undo]').click();
  await expect.poll(async () => (await scene(frame)).bodies[0].angle).toBeCloseTo(6, 6);

  // A bad designation is refused with its reason; a good one renames the body.
  await naca.fill('2012');
  await naca.press('Enter');
  await expect(frame.locator('[data-t2d-naca-error]')).toContainText('camber and its position');
  expect((await scene(frame)).bodies[0].shape.code).toBe('2412');
  await naca.fill('0015');
  await naca.press('Enter');
  await expect.poll(async () => (await scene(frame)).bodies[0].shape.code).toBe('0015');
  expect((await scene(frame)).bodies[0].name).toBe('NACA 0015');

  // Add a cylinder and an airfoil; remove the cylinder; Undo brings it back.
  await frame.getByRole('combobox', { name: 'Add shape' }).selectOption('circle');
  await frame.locator('[data-t2d-add="naca"]').click();
  await expect.poll(async () => (await scene(frame)).bodies.length).toBe(3);
  const cyl = (await scene(frame)).bodies.find((x) => x.shape.kind === 'circle');
  await frame.locator(`[data-t2d-body="${cyl.id}"]`).click();
  await frame.locator(`[data-t2d-remove="${cyl.id}"]`).click();
  await expect.poll(async () => (await scene(frame)).bodies.length).toBe(2);
  await expect(page.locator('body')).toContainText('Removed Cylinder');
  await frame.locator('[data-t2d-undo]').click();
  await expect.poll(async () => (await scene(frame)).bodies.some((x) => x.id === cyl.id)).toBe(true);
  // All three run in the flow at once.
  await expect.poll(async () => (await stats(frame)).state).toBe('running');

  // The field views, each with its legend.
  const show = frame.getByRole('combobox', { name: 'Show' });
  await show.selectOption('speed');
  await expect(frame.locator('[data-t2d-legend]')).toContainText('Speed');
  await expect(frame.locator('[data-t2d-legend]')).toContainText('m/s');
  // Speed: the automatic range reaches at least about the free stream's 10 m/s.
  await expect.poll(async () => Number(await frame.locator('[data-t2d-legend]').getAttribute('data-hi')), { timeout: 60_000 }).toBeGreaterThan(9);
  await show.selectOption('pressure');
  await expect(frame.locator('[data-t2d-legend]')).toContainText('Cp');
  await show.selectOption('schlieren');
  await expect(frame.locator('[data-t2d-legend]')).toContainText('Density gradient');

  // Pause stops the flow's clock; Run starts it again.
  await frame.locator('[data-t2d-play]').click();
  await expect(frame.locator('[data-t2d-status]')).toHaveAttribute('data-state', 'paused');
  const t1 = (await stats(frame)).simTime;
  await page.waitForTimeout(500);
  expect((await stats(frame)).simTime).toBe(t1);
  await frame.locator('[data-t2d-play]').click();
  await expect.poll(async () => (await stats(frame)).simTime, { timeout: 10_000 }).toBeGreaterThan(t1);
});

test('spin (the Magnus effect and its cap), the wall kinds, the resolution and a .dat import', async ({ page, request }) => {
  needsFastGpu();
  const study = await newTunnel(request, 'Options tunnel');
  const frame = await openTunnel(page, study);
  const foil = (await scene(frame)).bodies[0];
  await frame.locator(`[data-t2d-body="${foil.id}"]`).click();
  await frame.locator(`[data-t2d-remove="${foil.id}"]`).click();
  await frame.getByRole('combobox', { name: 'Add shape' }).selectOption('circle');
  await expect.poll(async () => (await scene(frame)).bodies.length).toBe(1);
  const cyl = (await scene(frame)).bodies[0];
  expect(cyl.shape).toMatchObject({ kind: 'circle', diameter: 0.4 });
  // 716 rpm counter-clockwise: the edge at 1.5 x the wind speed. The top moves against the
  // wind, so the cylinder is pushed down (Kutta–Joukowski): a clearly negative lift.
  const spin = frame.getByRole('textbox', { name: 'Spin', exact: true });
  await spin.fill('716');
  await spin.press('Enter');
  await expect.poll(async () => (await scene(frame)).bodies[0].spin, { timeout: 10_000 }).toBeCloseTo((716 * 2 * Math.PI) / 60, 3);
  await expect.poll(async () => (await T(frame, (id) => window.__TUNNEL__.bodyLive(id), cyl.id)).cl, { timeout: 60_000 }).toBeLessThan(-0.5);
  await expect(frame.locator('[data-t2d-spin-capped]')).toHaveCount(0);
  // 3000 rpm: the edge would pass twice the wind speed; held there, and the panel says so.
  await spin.fill('3000');
  await spin.press('Enter');
  await expect(frame.locator('[data-t2d-spin-capped]')).toContainText('rpm');
  await page.waitForTimeout(2000);
  expect((await stats(frame)).state).toBe('running');

  // The wall kinds: each runs.
  const walls = frame.getByRole('combobox', { name: 'Walls' });
  for (const w of ['noslip', 'periodic', 'slip', 'farfield']) {
    await walls.selectOption(w);
    await expect.poll(async () => (await scene(frame)).tunnel.walls).toBe(w);
    const t0 = (await stats(frame)).simTime;
    await expect.poll(async () => (await stats(frame)).simTime, { timeout: 20_000 }).toBeGreaterThan(t0);
    await page.waitForTimeout(1500);
    expect((await stats(frame)).state, w).toBe('running');
  }

  // Low resolution: 512 x 256 cells for this 8 m x 4 m tunnel.
  await frame.getByRole('combobox', { name: 'Resolution' }).selectOption('low');
  await expect(frame.locator('[data-t2d-status]')).toHaveAttribute('data-grid', '512x256', { timeout: 20_000 });

  // A .dat file through the file picker: a symmetric 12 % section in Selig order (upper
  // surface from the trailing edge to the leading edge, then the lower one back).
  const half = [];
  for (let i = 0; i <= 40; i++) {
    const x = 0.5 * (1 + Math.cos((Math.PI * i) / 40)); // 1 -> 0
    half.push([x, 0.6 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4)]);
  }
  const upper = half.map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`);
  const lower = half.slice(0, -1).reverse().map(([x, y]) => `${x.toFixed(6)} ${(-y).toFixed(6)}`);
  const dat = ['MY FOIL 12', ...upper, ...lower].join('\n');
  await frame.locator('[data-t2d-file]').setInputFiles({ name: 'my-foil.dat', mimeType: 'text/plain', buffer: Buffer.from(dat) });
  await expect.poll(async () => (await scene(frame)).bodies.some((b) => b.shape.kind === 'dat' && b.name === 'MY FOIL 12'), { timeout: 10_000 }).toBe(true);
  await expect(page.locator('body')).toContainText('Imported MY FOIL 12');
  // A file that is not an airfoil is refused, naming the file and the line.
  await frame.locator('[data-t2d-file]').setInputFiles({ name: 'notes.dat', mimeType: 'text/plain', buffer: Buffer.from('hello\n1 2 3\n') });
  await expect(page.locator('body')).toContainText('notes.dat: Line 2');
  expect((await scene(frame)).bodies).toHaveLength(2);
});

test("the plugin's solver passes the Schäfer–Turek 2D-2 cylinder benchmark", async ({ page, request }) => {
  needsFastGpu();
  const study = await newTunnel(request, 'Validation tunnel');
  const frame = await openTunnel(page, study);
  // The tunnel itself pauses so the benchmark has the GPU.
  await frame.locator('[data-t2d-play]').click();
  const r = await T(frame, () => window.__TUNNEL__.validate(20, 200));
  console.log(`2D-2 at 20 cells per D: St ${r.St.toFixed(4)}, Cd max ${r.cdMax.toFixed(4)}, Cl max ${r.clMax.toFixed(4)}, ${r.periods} periods, ${r.seconds.toFixed(1)} s`);
  expect(r.bad).toBe(0);
  // The limiter (for flow squeezed between bodies) never touches a clean run.
  expect(r.limited).toBe(0);
  expect(r.periods).toBeGreaterThanOrEqual(5);
  expect(r.St).toBeGreaterThanOrEqual(0.295);
  expect(r.St).toBeLessThanOrEqual(0.305);
  // Within 3 % of the benchmark's band (3.22–3.24).
  expect(r.cdMax).toBeGreaterThan(3.22 * 0.97);
  expect(r.cdMax).toBeLessThan(3.24 * 1.03);
});

test('dragging and turning bodies for a while never makes the flow unstable', async ({ page, request }) => {
  needsFastGpu();
  test.setTimeout(SOAK_MS + 300_000);
  page.on('crash', () => console.log(`soak: the page crashed at ${new Date().toISOString()}`));
  page.on('console', (m) => m.type() === 'error' && console.log(`soak console: ${m.text().slice(0, 300)}`));
  const study = await newTunnel(request, 'Soak tunnel');
  const frame = await openTunnel(page, study);
  await frame.getByRole('combobox', { name: 'Add shape' }).selectOption('circle');
  await frame.getByRole('combobox', { name: 'Add shape' }).selectOption('plate');
  await expect.poll(async () => (await scene(frame)).bodies.length).toBe(3);
  const end = Date.now() + SOAK_MS;
  let i = 0;
  while (Date.now() < end) {
    const s = await scene(frame);
    const b = s.bodies[i % s.bodies.length];
    const p = await pageXY(page, frame, await T(frame, ([x, y]) => window.__TUNNEL__.toScreen(x, y), [b.x, b.y]));
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const ang = (i * 0.7) % (2 * Math.PI);
    for (let k = 1; k <= 8; k++) await page.mouse.move(p.x + Math.cos(ang) * k * 12, p.y + Math.sin(ang) * k * 8);
    await page.mouse.up();
    i++;
    const st = await stats(frame);
    expect(st.state, `after ${i} drags: ${JSON.stringify({ at: st.unstableAt, bodies: (await scene(frame)).bodies.map((x) => [x.shape.kind, x.x, x.y, x.angle]) })}`).not.toBe('unstable');
  }
  await page.waitForTimeout(2000);
  expect((await stats(frame)).state).toBe('running');
  await expect(frame.locator('[data-t2d-unstable]')).toHaveCount(0);
});

test('a body dragged into another one keeps the flow stable and the page says the flow was held to its limits', async ({ page, request }) => {
  needsFastGpu();
  // Bug found by the soak (T1): a cylinder pushed into the airfoil trapped fluid in the closing
  // gap; its density ran away and the whole flow stopped as unstable.
  const study = await newTunnel(request, 'Squeeze tunnel');
  const frame = await openTunnel(page, study);
  await frame.getByRole('combobox', { name: 'Add shape' }).selectOption('circle');
  await expect.poll(async () => (await scene(frame)).bodies.length).toBe(2);
  const [foil, cyl] = (await scene(frame)).bodies;
  // Drag the cylinder onto the airfoil's upper surface at mid-chord, in small steps.
  const from = await pageXY(page, frame, await T(frame, ([x, y]) => window.__TUNNEL__.toScreen(x, y), [cyl.x, cyl.y]));
  const to = await pageXY(page, frame, await T(frame, ([x, y]) => window.__TUNNEL__.toScreen(x, y), [foil.x + 0.25, foil.y + 0.12]));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 30; k++) {
    await page.mouse.move(from.x + ((to.x - from.x) * k) / 30, from.y + ((to.y - from.y) * k) / 30);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await expect(frame.locator('[data-t2d-squeeze]')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3000);
  const st = await stats(frame);
  expect(st.state, JSON.stringify(st.unstableAt)).toBe('running');
  expect(st.limitedTotal).toBeGreaterThan(0);
  await expect(frame.locator('[data-t2d-unstable]')).toHaveCount(0);
});

test('a fast drag leaves no sound waves ringing through the tunnel', async ({ page, request }) => {
  // Bug Daniel saw (T3): after dragging the airfoil, diamond patterns filled the field:
  // pressure waves from the jolted body, bouncing between the walls (the lattice's sound is
  // only ~11 x the wind speed). Fixed by a smooth follow of the dragged pose, open top and
  // bottom (waves pass out) and bulk viscosity. Measured: upstream |grad rho| 0.7 s after
  // this drag was 43.5 before, about 0.07 after (calm: about 0.06-0.09).
  needsFastGpu();
  const frame = await openTunnel(page, await newTunnel(request, 'Waves tunnel'));
  await frame.getByRole('combobox', { name: 'Show' }).selectOption('schlieren');
  const band = () =>
    T(frame, async () => {
      // Null while another read is in flight (the colour range reads every 400 ms): try again.
      let s = null;
      for (let t = 0; t < 50 && !s; t++) {
        s = await window.__TUNNEL__.sampleField();
        if (!s) await new Promise((r) => setTimeout(r, 50));
      }
      const st = window.__TUNNEL__.stats();
      const w = Math.ceil(st.nx / 4);
      const h = Math.ceil(st.ny / 4);
      let sum = 0;
      let n = 0;
      for (let j = 0; j < h; j++) for (let i = Math.floor(w * 0.08); i < Math.floor(w * 0.22); i++) { const v = s[j * w + i]; if (v != null) { sum += Math.abs(v); n++; } }
      return sum / n;
    });
  await page.waitForTimeout(6000);
  const calm = await band();
  const b = (await scene(frame)).bodies[0];
  const at = await pageXY(page, frame, await T(frame, ([x, y]) => window.__TUNNEL__.toScreen(x, y), [b.x + 0.15, b.y]));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) { await page.mouse.move(at.x, at.y - i * 10); await page.waitForTimeout(30); }
  for (let i = 1; i <= 30; i++) { await page.mouse.move(at.x, at.y - 150 + i * 10); await page.waitForTimeout(30); }
  await page.mouse.up();
  await page.waitForTimeout(700);
  const after = await band();
  console.log(`upstream |grad rho|: calm ${calm.toFixed(4)}, 0.7 s after the drag ${after.toFixed(4)}`);
  expect(after).toBeLessThan(Math.max(0.5, 6 * calm));
});

test('the rheoscopic view: flakes carried and turned by the flow, dull where it is still', async ({ page, request }) => {
  needsFastGpu();
  const frame = await openTunnel(page, await newTunnel(request, 'Rheo tunnel'));
  await frame.getByRole('combobox', { name: 'Show' }).selectOption('rheoscopic');
  await expect(frame.locator('[data-t2d-legend]')).toHaveCount(0);
  await expect(frame.getByRole('combobox', { name: 'Flakes' })).toBeVisible();
  await page.waitForTimeout(6000);
  const r = await T(frame, () => window.__TUNNEL__.rheo());
  expect(r.nan).toBe(0);
  // A second moment: trace 1 everywhere, off-diagonals bounded (they once ran away to 1e31).
  expect(Math.abs(r.meanTrace - 1)).toBeLessThan(1e-3);
  expect(r.meanAbsXY).toBeLessThan(0.5);
  // The flow lays flakes down and turns them: from nearly upright to nearly flat.
  expect(r.maxZZ - r.minZZ).toBeGreaterThan(0.5);
  for (const preset of ['pearl', 'copper', 'kalliroscope']) {
    await frame.getByRole('combobox', { name: 'Flakes' }).selectOption(preset);
    await expect.poll(async () => (await scene(frame)).view.rheoPreset).toBe(preset);
  }
  expect((await stats(frame)).state).toBe('running');
});

test('without WebGPU the page says why it cannot run', async ({ browser, request }) => {
  const study = await newTunnel(request, 'No GPU tunnel');
  // Two browsers without WebGPU, made so in every frame before any script runs: one with no
  // navigator.gpu at all, one whose GPU offers no adapter.
  const cases = [
    { init: () => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }), says: 'navigator.gpu is missing' },
    { init: () => { if (globalThis.GPU) GPU.prototype.requestAdapter = async () => null; }, says: 'found no GPU it can use' },
  ];
  for (const c of cases) {
    const ctx = await browser.newContext();
    try {
      await ctx.addInitScript(c.init);
      const page = await ctx.newPage();
      await page.goto(`${host.base}/#/p/${PROJECT}/ws/${KEY}/${KIND}/${study.id}`);
      const text = () => {
        const f = page.frames().find((x) => x.url().includes(`/plugins/${KEY}/`));
        return f ? f.evaluate(() => document.querySelector('[data-t2d-fatal]')?.textContent ?? '').catch(() => '') : '';
      };
      await expect.poll(text, { timeout: 90_000 }).toContain('This wind tunnel needs WebGPU');
      expect(await text()).toContain(c.says);
    } finally {
      await ctx.close();
    }
  }
});
