// Forces, surface pressure, probes and the angle sweep (T5), from the panels.
//
// 1. NACA 0012 at 0°: the Forces panel's mean lift and moment are nil, the surface pressure is
//    the same on both sides with a stagnation point at the nose, and the panel says what the
//    numbers were run at.
// 2. The default airfoil (NACA 2412 at 6°, Re 660,000): the surface pressure against XFOIL's
//    (forced transition, Re 666,667); the moment from the momentum exchange equals the moment of
//    the surface pressure; and refined (x2) the lift and moment come to XFOIL's.
// 3. Probes: a probe reads the wind in the free stream and less in the wake, drags, is saved
//    and is removed with Delete; hovering over the flow reads it in the toolbar's hint.
// 4. An angle sweep of NACA 0012 over -4..4°: lift antisymmetric, the slope XFOIL gives, the
//    angle put back, the rows kept with the scene.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { T, newTunnel, openTunnel, pageXY, scene, useTunnelHost, worldToPage } from './helpers.js';

const env = useTunnelHost('tunnel2d-forces');

/** XFOIL, NACA 2412, alpha 6, Re 666,667, transition forced at the nose: Cl, Cm about c/4, and Cp. */
const XFOIL_2412_6 = {
  cl: 0.8623,
  cm: -0.0444,
  upper: { 0.1: -1.393, 0.2: -1.14, 0.3: -0.951, 0.5: -0.6, 0.7: -0.327, 0.9: -0.025 },
  lower: { 0.1: 0.318, 0.2: 0.192, 0.3: 0.154, 0.5: 0.118, 0.7: 0.114, 0.9: 0.123 },
};
/** XFOIL, NACA 0012, Re 666,667, forced transition: lift slope per degree (alpha 0 to 4). */
const XFOIL_0012_SLOPE = 0.4328 / 4;

const force = async (frame, key) => Number(await frame.locator(`[data-t2d-force="${key}"]`).getAttribute('data-mean'));

/** Select the body and set its NACA code and angle in the Body panel. */
async function setAirfoil(frame, id, code, angle) {
  await frame.locator(`[data-t2d-body="${id}"]`).click();
  const naca = frame.getByRole('textbox', { name: 'NACA designation' });
  await naca.fill(code);
  await naca.press('Enter');
  const ang = frame.getByRole('textbox', { name: 'Angle' });
  await ang.fill(String(angle));
  await ang.press('Enter');
}

/** Wait for the panel's mean, then a few more passes. */
async function settledMeans(page, frame, extraMs = 6000) {
  await expect(frame.locator('[data-t2d-force-window]')).toHaveAttribute('data-t2d-force-window', 'mean', { timeout: 60_000 });
  await page.waitForTimeout(extraMs);
}

/** The surface pressure averaged over `n` reads: upper and lower, interpolated at x/c. */
async function meanCp(page, frame, id, n = 20) {
  let acc = null;
  let k = 0;
  for (let i = 0; i < n * 2 && k < n; i++) {
    const s = await T(frame, (b) => window.__TUNNEL__.surfaceCp(b), id);
    if (s && (!acc || (acc.upper.length === s.upper.length && acc.lower.length === s.lower.length))) {
      if (!acc) acc = s;
      else {
        s.upper.forEach((p, j) => (acc.upper[j].cp += p.cp));
        s.lower.forEach((p, j) => (acc.lower[j].cp += p.cp));
      }
      k++;
    }
    await page.waitForTimeout(120);
  }
  for (const c of [acc.upper, acc.lower]) for (const p of c) p.cp /= k;
  const at = (c, x) => {
    for (let i = 1; i < c.length; i++) if (c[i].x >= x) return c[i - 1].cp + ((x - c[i - 1].x) / (c[i].x - c[i - 1].x || 1)) * (c[i].cp - c[i - 1].cp);
    return c[c.length - 1].cp;
  };
  return { ...acc, at };
}

/** The moment of the surface pressure about the quarter chord (nose up positive), and its normal force. */
function pressureMoment(cp) {
  const integ = (c, f) => c.slice(1).reduce((s, p, i) => s + 0.5 * (f(c[i]) + f(p)) * (p.x - c[i].x), 0);
  return {
    cn: integ(cp.lower, (p) => p.cp) - integ(cp.upper, (p) => p.cp),
    cm: integ(cp.upper, (p) => p.cp * (p.x - 0.25)) - integ(cp.lower, (p) => p.cp * (p.x - 0.25)),
  };
}

test('NACA 0012 at 0°: no lift, no moment, the same pressure on both sides, and the basis stated', async ({ page, request }) => {
  env.needsFastGpu();
  test.setTimeout(240_000);
  const study = await newTunnel(env.host, request, 'Forces 0012');
  const frame = await openTunnel(env.host, page, study);
  const id = (await scene(frame)).bodies[0].id;
  await setAirfoil(frame, id, '0012', 0);
  await settledMeans(page, frame);
  const cl = await force(frame, 'cl');
  const cm = await force(frame, 'cm');
  const cd = await force(frame, 'cd');
  console.log(`0012 at 0: Cl ${cl}, Cm ${cm}, Cd ${cd}`);
  expect(Math.abs(cl)).toBeLessThan(0.02);
  expect(Math.abs(cm)).toBeLessThan(0.01);
  expect(cd).toBeGreaterThan(0);
  await expect(frame.locator('[data-t2d-force-basis]')).toHaveAttribute('data-t2d-force-basis', 'sa');
  await expect(frame.locator('[data-t2d-force-basis]')).toContainText('Re 660,000 · turbulence model');
  await expect(frame.locator('[data-t2d-force-basis]')).toContainText('moment about the quarter chord, nose up positive');
  // The surface pressure plot reads, and both sides match.
  await expect.poll(async () => Number(await frame.locator('[data-t2d-cp-reads]').getAttribute('data-t2d-cp-reads')), { timeout: 20_000 }).toBeGreaterThan(3);
  await expect(frame.getByRole('img', { name: 'Pressure coefficient along the surface' })).toBeVisible();
  const cp = await meanCp(page, frame, id);
  for (const x of [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9]) expect(Math.abs(cp.at(cp.upper, x) - cp.at(cp.lower, x)), `x/c ${x}`).toBeLessThan(0.03);
  const peak = Math.max(...cp.upper.map((p) => p.cp), ...cp.lower.map((p) => p.cp));
  console.log(`0012 at 0: stagnation Cp ${peak.toFixed(3)}`);
  expect(peak).toBeGreaterThan(0.7);
  expect(peak).toBeLessThan(1.1);
});

test('NACA 2412 at 6°: surface pressure against XFOIL, the moment two ways, and refined lift and moment', async ({ page, request }) => {
  env.needsFastGpu();
  test.setTimeout(360_000);
  const study = await newTunnel(env.host, request, 'Forces 2412');
  const frame = await openTunnel(env.host, page, study);
  const id = (await scene(frame)).bodies[0].id;
  await frame.locator(`[data-t2d-body="${id}"]`).click();
  await settledMeans(page, frame, 8000);
  const cp = await meanCp(page, frame, id);
  for (const side of ['upper', 'lower']) {
    for (const [x, ref] of Object.entries(XFOIL_2412_6[side])) {
      const v = cp.at(cp[side], Number(x));
      expect(Math.abs(v - ref), `${side} x/c ${x}: ${v.toFixed(3)} against XFOIL ${ref}`).toBeLessThan(0.12);
    }
  }
  // The momentum exchange's moment and the surface pressure's: two ways to the same number.
  const cm = await force(frame, 'cm');
  const pm = pressureMoment(cp);
  console.log(`2412 at 6, default grid: Cm ${cm.toFixed(4)} (pressure ${pm.cm.toFixed(4)}), Cl ${(await force(frame, 'cl')).toFixed(4)} (pressure normal force ${pm.cn.toFixed(4)})`);
  expect(Math.abs(cm - pm.cm)).toBeLessThan(0.01);
  // Refined (x2, 256 cells per chord): lift and moment come to XFOIL's.
  await frame.getByRole('combobox', { name: 'Refine near bodies' }).selectOption('1');
  await page.waitForTimeout(3000);
  await settledMeans(page, frame, 12_000);
  const cl2 = await force(frame, 'cl');
  const cm2 = await force(frame, 'cm');
  console.log(`2412 at 6, x2: Cl ${cl2.toFixed(4)} (XFOIL ${XFOIL_2412_6.cl}), Cm ${cm2.toFixed(4)} (XFOIL ${XFOIL_2412_6.cm})`);
  expect(Math.abs(cl2 / XFOIL_2412_6.cl - 1)).toBeLessThan(0.06);
  expect(Math.abs(cm2 - XFOIL_2412_6.cm)).toBeLessThan(0.012);
});

test('probes read the flow, drag, are saved and deleted; hovering reads the flow under the pointer', async ({ page, request }) => {
  env.needsGpu();
  test.setTimeout(240_000);
  const study = await newTunnel(env.host, request, 'Probes');
  const frame = await openTunnel(env.host, page, study);
  const s0 = await scene(frame);
  const b = s0.bodies[0];
  await page.waitForTimeout(6000);
  // Hover in the free stream a chord and a half ahead of the airfoil: the hint reads the wind.
  // (Not above it: a lifting airfoil's circulation speeds the flow there, Γ/2πr, half a metre
  // a second at 1.4 m.)
  const free = await worldToPage(page, frame, b.x - 1.5, b.y);
  await page.mouse.move(free.x, free.y);
  await page.mouse.move(free.x + 2, free.y + 1);
  await expect(frame.locator('[data-t2d-hint]')).toContainText('|u|', { timeout: 10_000 });
  const hint = await frame.locator('[data-t2d-hint]').textContent();
  const speed = Number(/\|u\| ([\d.]+)/.exec(hint)[1]);
  console.log(`hover: ${hint}`);
  expect(Math.abs(speed / s0.flow.speed - 1)).toBeLessThan(0.05);
  // A probe, dragged into the free stream: the wind, and the free stream's pressure.
  await frame.locator('[data-t2d-add-probe]').click();
  const probe = (await scene(frame)).probes[0];
  await expect(frame.locator('[data-t2d-probe-name]')).toHaveText('P1');
  const from = await worldToPage(page, frame, probe.x, probe.y);
  const to = await worldToPage(page, frame, b.x - 1.5, b.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const moved = (await scene(frame)).probes[0];
  expect(Math.abs(moved.x - (b.x - 1.5))).toBeLessThan(0.05);
  expect(Math.abs(moved.y - b.y)).toBeLessThan(0.05);
  await page.waitForTimeout(1500);
  const reading = frame.locator(`[data-t2d-probe-reading="${probe.id}"]`);
  await expect(reading).toBeVisible();
  const fs = Number(await reading.getAttribute('data-speed'));
  const fcp = Number(await reading.getAttribute('data-cp'));
  console.log(`free-stream probe: ${fs} m/s, Cp ${fcp}`);
  expect(Math.abs(fs / s0.flow.speed - 1)).toBeLessThan(0.03);
  expect(Math.abs(fcp)).toBeLessThan(0.05);
  await expect(frame.getByRole('img', { name: 'Probe readings over time' })).toBeVisible({ timeout: 10_000 });
  // The slowest point a quarter chord behind the trailing edge (the wake), by its x field.
  const xw = b.x + 0.75 + 0.25;
  const line = await T(frame, ([x, y]) => window.__TUNNEL__.readAt(Array.from({ length: 41 }, (_, i) => ({ x, y: y - 0.4 + i * 0.02 }))), [xw, b.y]);
  let k = 0;
  line.forEach((r, i) => !r.inBody && r.speed < line[k].speed && (k = i));
  const yw = b.y - 0.4 + k * 0.02;
  for (const [label, v] of [['Probe x', xw], ['Probe y', yw]]) {
    const box = frame.getByRole('textbox', { name: label });
    await box.fill(v.toFixed(3));
    await box.press('Enter');
  }
  await page.waitForTimeout(1500);
  const ws = Number(await reading.getAttribute('data-speed'));
  console.log(`wake probe: ${ws} m/s`);
  expect(ws).toBeLessThan(0.9 * s0.flow.speed);
  // Saved: back after a reload, in its place.
  await expect.poll(() => T(frame, () => window.__TUNNEL__.save()), { timeout: 30_000 }).toBe('saved');
  const again = await openTunnel(env.host, page, study);
  const kept = (await scene(again)).probes;
  expect(kept).toHaveLength(1);
  expect(kept[0].x).toBeCloseTo(xw, 3);
  // Delete removes the selected probe.
  await again.locator(`[data-t2d-probe="${probe.id}"]`).click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await scene(again)).probes.length).toBe(0);
  expect((await scene(again)).bodies).toHaveLength(1);
});

test('an angle sweep of NACA 0012: lift antisymmetric with the slope XFOIL gives, the angle put back, the rows kept', async ({ page, request }) => {
  env.needsFastGpu();
  test.setTimeout(300_000);
  const study = await newTunnel(env.host, request, 'Sweep');
  const frame = await openTunnel(env.host, page, study);
  const id = (await scene(frame)).bodies[0].id;
  await setAirfoil(frame, id, '0012', 2);
  for (const [label, v] of [['Sweep from', -4], ['Sweep to', 4], ['Sweep step', 4]]) {
    const box = frame.getByRole('textbox', { name: label });
    await box.fill(String(v));
    await box.press('Enter');
  }
  await frame.locator('[data-t2d-sweep-start]').click();
  await expect(frame.locator('[data-t2d-sweep-progress]')).toBeVisible();
  // While it runs the body is at the sweep's angle.
  await expect.poll(async () => (await scene(frame)).bodies[0].angle, { timeout: 10_000 }).toBe(-4);
  await expect(frame.locator('[data-t2d-sweep-start]')).toBeVisible({ timeout: 240_000 });
  const rows = await frame.locator('[data-t2d-sweep-row]').evaluateAll((els) => els.map((e) => ({ a: Number(e.getAttribute('data-t2d-sweep-row')), cl: Number(e.getAttribute('data-cl')), cm: Number(e.getAttribute('data-cm')) })));
  console.log(`sweep: ${JSON.stringify(rows)}`);
  expect(rows.map((r) => r.a)).toEqual([-4, 0, 4]);
  const [lo, mid, hi] = rows;
  expect(Math.abs(mid.cl)).toBeLessThan(0.03);
  expect(Math.abs(lo.cl + hi.cl)).toBeLessThan(0.04);
  const slope = (hi.cl - lo.cl) / 8;
  expect(Math.abs(slope / XFOIL_0012_SLOPE - 1), `slope ${slope.toFixed(4)} per degree against XFOIL ${XFOIL_0012_SLOPE.toFixed(4)}`).toBeLessThan(0.15);
  for (const r of rows) expect(Math.abs(r.cm)).toBeLessThan(0.03);
  // The angle is back, and the plots and the result are there, labelled.
  const s = await scene(frame);
  expect(s.bodies[0].angle).toBe(2);
  expect(s.sweep.rows).toHaveLength(3);
  expect(s.sweep.model).toBe('sa');
  await expect(frame.locator('[data-t2d-sweep-rows]')).toContainText('NACA 0012 · Re 660,000 · turbulence model');
  await expect(frame.getByRole('img', { name: 'Drag polar' })).toBeVisible();
});
