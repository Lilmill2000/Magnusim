// The turbulence model (R1): Spalart–Allmaras with wall functions, at the real Reynolds number.
//
// 1. The default airfoil (NACA 2412 at 6°, Re 660,000) runs on the model: the flow settles
//    to a steady attached flow (lift steady to a few percent, not a shedding wake) with a
//    lift coefficient where XFOIL puts it, and dragging the airfoil keeps it stable.
// 2. The plugin's own checks of the model, run through its solver: a flat plate's skin
//    friction against White's turbulent law, and NACA 0012 at Re 6 million and 4° against
//    the NASA SA result.
// 3. Switching the flow model while the flow runs (resolved, the model, back) never holds
//    the flow still or drops it to a few steps a frame (the solver builds the other model's
//    pipelines ahead of time; a frame held up once is not a slow GPU).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { T, newTunnel, openTunnel, pageXY, scene, stats, useTunnelHost } from './helpers.js';

const env = useTunnelHost('tunnel2d-turb');

/** The body's lift coefficient over a few seconds: mean and spread. */
async function liftOver(page, frame, id, ms) {
  const xs = [];
  for (let t = 0; t < ms; t += 250) {
    xs.push((await T(frame, (b) => window.__TUNNEL__.bodyLive(b), id)).cl);
    await page.waitForTimeout(250);
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, spread: Math.max(...xs) - Math.min(...xs) };
}

test('the default airfoil runs steadily on the turbulence model, with the lift XFOIL gives, and drags stably', async ({ page, request }) => {
  env.needsFastGpu();
  test.setTimeout(240_000);
  const study = await newTunnel(env.host, request, 'Turbulence model tunnel');
  const frame = await openTunnel(env.host, page, study);
  await expect(frame.locator('[data-t2d-re]')).toHaveAttribute('data-t2d-model', 'sa');
  const id = (await scene(frame)).bodies[0].id;
  // Let the flow cross the tunnel a few times (a steady state), then read the lift.
  const st = await stats(frame);
  const crossing = 8 / 10; // an 8 m tunnel at 10 m/s
  await expect.poll(async () => (await stats(frame)).simTime, { timeout: 150_000, intervals: [1000] }).toBeGreaterThan(st.simTime + 4 * crossing);
  const lift = await liftOver(page, frame, id, 3000);
  // XFOIL (transition forced at the nose, free air): NACA 2412 at 6°, Re 660,000: CL 0.86.
  // The open tunnel is 4 chords tall and the model reads up to about 10 % low: 0.7 to 1.0.
  expect(lift.mean).toBeGreaterThan(0.7);
  expect(lift.mean).toBeLessThan(1.0);
  // Steady: attached flow, no shedding (the resolved flow at the grid's Re swings by 0.2 and more).
  expect(lift.spread).toBeLessThan(0.03);
  expect((await stats(frame)).state).toBe('running');

  // A drag through the flow on the model stays stable.
  const b = (await scene(frame)).bodies[0];
  const at = await pageXY(page, await T(frame, ([x, y]) => window.__TUNNEL__.toScreen(x, y), [b.x + 0.15, b.y]));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(at.x + i * 6, at.y + (i % 10 < 5 ? i % 10 : 10 - (i % 10)) * 6);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(3000);
  expect((await stats(frame)).state).toBe('running');
  expect(Number.isFinite((await T(frame, (bid) => window.__TUNNEL__.bodyLive(bid), id)).cl)).toBe(true);
});

test("the model's checks: flat-plate skin friction and NACA 0012 lift at Re 6 million", async ({ page, request }) => {
  env.needsFastGpu();
  test.setTimeout(240_000);
  const study = await newTunnel(env.host, request, 'Turbulence checks');
  const frame = await openTunnel(env.host, page, study);
  // Pause the tunnel itself while the checks run.
  await frame.getByRole('button', { name: /pause/i }).first().click();

  // A plate 800 cells long at Re_L 4 million: local Cf within 6 % of White's turbulent law
  // from 30 % of its length on (the run measured 0 to 4 %).
  const L = 800;
  const plate = await T(frame, (len) => window.__TUNNEL__.validatePlate({ length: len, re: 4e6, turb: 'sa', tstar: 4 }), L);
  expect(plate.bad).toBe(0);
  const xLE = 0.3 * L;
  const yc = Math.round(0.2 * L) + 0.3;
  const top = plate.panels.filter((p) => p.ny > 0.99 && p.y > yc);
  for (const f of [0.3, 0.5, 0.7, 0.9]) {
    const x = xLE + f * L;
    const p = top.reduce((a, q) => (Math.abs(q.x - x) < Math.abs(a.x - x) ? q : a), top[0]);
    const reX = (4e6 * (p.x - xLE)) / L;
    const white = 0.455 / Math.log(0.06 * reX) ** 2;
    expect(Math.abs(Math.abs(p.cf) / white - 1), `Cf at x/L ${f}`).toBeLessThan(0.06);
  }

  // NACA 0012 at 4°, Re 6 million, 200 cells per chord: CL 0.44 (NASA's SA results by
  // their lift slope; Ladson's experiment): within 5 %. Steady, and the drag positive.
  const foil = await T(frame, () => window.__TUNNEL__.validateAirfoil({ code: '0012', alpha: 4, chord: 200, re: 6e6, turb: 'sa', tstar: 12 }));
  expect(foil.bad).toBe(0);
  expect(foil.limited).toBe(0);
  expect(Math.abs(foil.cl / 0.44 - 1)).toBeLessThan(0.05);
  expect(foil.clSpread).toBeLessThan(0.01);
  expect(foil.cd).toBeGreaterThan(0.005);
});

test('switching the flow model while the flow runs never stalls it', async ({ page, request }) => {
  env.needsFastGpu();
  const study = await newTunnel(env.host, request, 'Model switch');
  const frame = await openTunnel(env.host, page, study);
  // A fixed grid: Auto picks one per flow model, and a new grid is a new flow.
  await frame.getByRole('combobox', { name: 'Resolution' }).selectOption('medium');
  await page.waitForTimeout(4000);
  await T(frame, () => {
    window.__rec = [];
    window.__recT = setInterval(() => {
      const s = window.__TUNNEL__.stats();
      window.__rec.push([performance.now(), s.simTime, s.stepsPerFrame]);
    }, 50);
  });
  await page.waitForTimeout(1500);
  const model = frame.getByRole('combobox', { name: 'Flow model' });
  for (const m of ['resolved', 'sa', 'resolved', 'auto']) {
    await model.selectOption(m);
    await page.waitForTimeout(2500);
  }
  const rec = await T(frame, () => {
    clearInterval(window.__recT);
    return window.__rec;
  });
  const before = rec.slice(0, 25).map((r) => r[2]).sort((a, b) => a - b)[12];
  let freeze = 0;
  let since = rec[0][0];
  for (let i = 1; i < rec.length; i++) {
    if (rec[i][1] !== rec[i - 1][1]) since = rec[i][0];
    freeze = Math.max(freeze, rec[i][0] - since);
  }
  // Each model runs at its own rate (the turbulence model's step costs more): the fewest
  // against the model's own, after its first half second.
  const fewest = Math.min(...rec.slice(25).map((r) => r[2]));
  console.log(`model switch: longest freeze ${Math.round(freeze)} ms, steps a frame ${before} before, ${fewest} at the fewest`);
  expect(freeze, 'the flow stood still this long (ms)').toBeLessThan(400);
  expect(fewest, `steps a frame fell to ${fewest} from ${before}`).toBeGreaterThan(before * 0.25);
});
