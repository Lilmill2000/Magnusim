// T6: the keyboard shortcuts and capture.
//
// 1. Picture (and C) downloads a PNG of the view: the flow itself, not a blank canvas, at the
//    view's size, with the legend and the caption drawn on it. Record (and Shift+C) records
//    the view and downloads a WebM when stopped.
// 2. The keys: ? lists the shortcuts; Space pauses and . steps the paused flow by one frame;
//    R resets it; F fits the view; 1-7 pick the view; [ and ] turn the selected body.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { newTunnel, openTunnel, scaledTimeout, scene, SLOW, stats, T, useTunnelHost } from './helpers.js';

const env = useTunnelHost('tunnel2d-capture');

/** A PNG's size and how varied its pixels are in a box (fractions of the picture), decoded in the page. */
async function pngStats(page, file, box) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(
    async ([data, bx]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const x0 = Math.floor(bx[0] * c.width);
      const y0 = Math.floor(bx[1] * c.height);
      const d = g.getImageData(x0, y0, Math.floor((bx[2] - bx[0]) * c.width), Math.floor((bx[3] - bx[1]) * c.height)).data;
      const colours = new Set();
      let opaque = 0;
      for (let i = 0; i < d.length; i += 4 * 7) {
        colours.add((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3));
        if (d[i + 3] > 250) opaque++;
      }
      return { w: c.width, h: c.height, colours: colours.size, opaque: opaque / (d.length / 28) };
    },
    [b64, box],
  );
}

/** A WebM played in the page: its size, and how many colours a frame a second in has. */
async function webmStats(page, file) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async (data) => {
    const bin = atob(data);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([u8], { type: 'video/webm' }));
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error(`the recording does not play (${v.error?.code})`));
    });
    await v.play().catch(() => {});
    await new Promise((res) => setTimeout(res, 1000));
    v.pause();
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) set.add((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3));
    return { w: v.videoWidth, h: v.videoHeight, colours: set.size };
  }, b64);
}

test('Picture saves the view as a PNG with its legend; Record saves a WebM that plays', async ({ page, request }) => {
  // A picture is drawn from a frame as the GPU finishes it, and a recording from a few
  // seconds of them: the software adapter draws about one a second.
  env.needsFastGpu();
  scaledTimeout(180_000);
  const frame = await openTunnel(env.host, page, await newTunnel(env.host, request, 'Capture'));
  await frame.getByRole('combobox', { name: 'Show' }).selectOption('vorticity');
  await page.waitForTimeout(4000);
  const view = await T(frame, () => window.__TUNNEL__.view());
  // The button.
  let pending = page.waitForEvent('download');
  await frame.locator('[data-t2d-picture]').click();
  let dl = await pending;
  expect(dl.suggestedFilename()).toMatch(/^tunnel-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}\.png$/);
  const png = await dl.path();
  const st = await pngStats(page, png, [0.3, 0.25, 0.7, 0.75]);
  console.log(`picture ${st.w} x ${st.h}, ${st.colours} colours in the middle, opaque ${st.opaque.toFixed(3)}`);
  expect(st.w).toBe(Math.round(view.w * view.dpr));
  expect(st.h).toBe(Math.round(view.h * view.dpr));
  // The flow's colours, not a blank or transparent canvas.
  expect(st.opaque).toBeGreaterThan(0.99);
  expect(st.colours).toBeGreaterThan(20);
  // The legend's colour bar, bottom left: the map's many colours.
  const legend = await pngStats(page, png, [0.0, 0.85, 0.2, 1.0]);
  expect(legend.colours).toBeGreaterThan(20);
  await expect(frame.locator('[data-t2d-hint]')).toBeDefined();
  // The key.
  pending = page.waitForEvent('download');
  await frame.locator('[data-t2d-viewport]').click({ position: { x: 20, y: 20 }, force: true });
  await page.keyboard.press('c');
  dl = await pending;
  expect(dl.suggestedFilename()).toMatch(/\.png$/);
  // A recording: Record, three seconds, Stop.
  const rec = frame.locator('[data-t2d-record]');
  await rec.click();
  await expect(rec).toHaveAttribute('data-t2d-record', 'on');
  await expect(rec).toContainText('Stop recording 0:0');
  await page.waitForTimeout(3000);
  pending = page.waitForEvent('download');
  await rec.click();
  dl = await pending;
  expect(dl.suggestedFilename()).toMatch(/\.webm$/);
  const size = readFileSync(await dl.path()).length;
  const vid = await webmStats(page, await dl.path());
  console.log(`recording: ${size} bytes, ${vid.w} x ${vid.h}, ${vid.colours} colours in a frame`);
  expect(size).toBeGreaterThan(20_000);
  // It plays, at the view's size, with the flow in it.
  expect(vid.w).toBe(Math.round(view.w * view.dpr));
  expect(vid.colours).toBeGreaterThan(20);
  await expect(rec).toHaveAttribute('data-t2d-record', 'off');
});

test('the keys: shortcuts list, pause and step, reset, fit, views, turning', async ({ page, request }) => {
  env.needsGpu();
  scaledTimeout(180_000);
  const frame = await openTunnel(env.host, page, await newTunnel(env.host, request, 'Keys'));
  const id = (await scene(frame)).bodies[0].id;
  await page.waitForTimeout(2000);
  // Focus the page (a click on empty space; it pans nothing).
  await frame.locator('[data-t2d-viewport]').click({ position: { x: 20, y: 20 }, force: true });
  // ? lists them; Escape closes the list.
  await page.keyboard.press('?');
  const help = frame.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Step the paused flow by one frame');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  // Space pauses: the time stands; . steps it by one frame's worth.
  await frame.locator('[data-t2d-viewport]').click({ position: { x: 20, y: 20 }, force: true });
  await page.keyboard.press(' ');
  await expect(frame.locator('[data-t2d-play]')).toHaveAttribute('data-t2d-play', 'paused');
  await page.waitForTimeout(500);
  const t0 = (await stats(frame)).simTime;
  await page.waitForTimeout(800);
  expect((await stats(frame)).simTime).toBe(t0);
  await page.keyboard.press('.');
  await expect.poll(async () => (await stats(frame)).simTime, { timeout: 5000 * SLOW }).toBeGreaterThan(t0);
  const t1 = (await stats(frame)).simTime;
  await page.waitForTimeout(800);
  expect((await stats(frame)).simTime).toBe(t1);
  // R: the flow starts again.
  await page.keyboard.press(' ');
  await page.waitForTimeout(1500);
  await page.keyboard.press('r');
  await expect.poll(async () => (await stats(frame)).simTime, { timeout: 5000 * SLOW }).toBeLessThan(t1);
  // F fits the view after a zoom.
  const v0 = await T(frame, () => window.__TUNNEL__.view());
  const box = await page.locator('#workspace-frame').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await T(frame, () => window.__TUNNEL__.view())).mpp).toBeLessThan(v0.mpp * 0.9);
  await page.keyboard.press('f');
  await expect.poll(async () => (await T(frame, () => window.__TUNNEL__.view())).mpp).toBeCloseTo(v0.mpp, 9);
  // 1-7 pick the view.
  await page.keyboard.press('3');
  await expect.poll(async () => (await scene(frame)).view.field).toBe('speed');
  await page.keyboard.press('2');
  await expect.poll(async () => (await scene(frame)).view.field).toBe('vorticity');
  // ] and [ turn the selected body (Shift: 10°), each an undo step.
  await frame.locator(`[data-t2d-body="${id}"]`).click();
  const a0 = (await scene(frame)).bodies[0].angle;
  await frame.locator('[data-t2d-viewport]').click({ position: { x: 20, y: 20 }, force: true });
  await frame.locator(`[data-t2d-body="${id}"]`).click();
  await page.keyboard.press(']');
  await expect.poll(async () => (await scene(frame)).bodies[0].angle).toBe(a0 + 1);
  await page.keyboard.press('Shift+BracketLeft');
  await expect.poll(async () => (await scene(frame)).bodies[0].angle).toBe(a0 - 9);
  await frame.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await scene(frame)).bodies[0].angle).toBe(a0 + 1);
});
