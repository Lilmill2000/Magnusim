// The 2D tunnel in the app's dark theme (Daniel, 2026-10-27).
//
// 1. What a person keeps stays light: a picture taken in dark is the light picture, pixel for
//    pixel, by the Picture button and by the C key, with the light margins (240, 242, 247) and
//    white cards; a recording stays light through theme changes while the screen never shows a
//    light margin; and with the theme dark before the tunnel opens, its first picture and its first
//    recorded frame are light (the class of the core's 1bc504eb).
// 2. The dark screen: the margins exactly (27, 31, 39) with a (107, 115, 130) ring on the tunnel's
//    wall; the GPU's frame and a box of the flow are the light ones; the rake swatches are the rakes'
//    colours, with a ring that reads on a selected row (none in light); a selected rake's end
//    squares have a light edge and the dashed outlines a halo (neither in light); the stage's text
//    reads at 4.5:1, nothing in it has a light background, and the only light island is the hidden
//    one kept light on purpose.
// 3. Live: a change of theme shows in the next frame on the view, the stage and the panels together;
//    a pan or zoom in dark never uncovers the GPU's light margin.
// The scene is still (paused) wherever pixels are compared. The theme is set as Settings →
// Appearance sets it (the host's applyAppearance, the frame following through the host) and is put
// back after each test. At device pixel ratios 1 and 1.25.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { newTunnel, openTunnel, pngPixels, scaledTimeout, SLOW, T, useTunnelHost } from './helpers.js';

const env = useTunnelHost('tunnel2d-dark');

const LIGHT_MARGIN = [240, 242, 247];
const DARK_MARGIN = [27, 31, 39];
const WALL = [107, 115, 130];

// The look back to light, even after a test that timed out (its finally would not run): the
// windows closed first, so none of them saves or shows it again.
test.afterEach(async ({ page, request }) => {
  for (const p of page.context().pages()) await p.close();
  if (!env.host) return;
  const r = await request.post(`${env.host.base}/api/prefs`, { data: { theme: 'light', text_scale: 1, icon_scale: 1 } });
  expect(r.ok(), await r.text()).toBe(true);
});

/** The app's theme as Settings → Appearance shows it; the tunnel's frame has it once the host relays it. */
async function setTheme(page, frame, theme) {
  await page.evaluate(async (t) => {
    const { applyAppearance } = await import('/src/theme/appearance.ts');
    applyAppearance({ theme: t, text_scale: 1, icon_scale: 1 });
  }, theme);
  await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme || 'light'), { message: "the tunnel's frame takes the app's theme" }).toBe(theme);
}

/** Wait for `n` frames of the tunnel's page. */
const rafs = (frame, n = 3) =>
  frame.evaluate(
    (k) =>
      new Promise((done) => {
        const step = () => (--k <= 0 ? done() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );

/**
 * The still scene: the airfoil selected and unlocked just under the top wall (its turn handle on the
 * margin), a cylinder switched off, a streak rake and a dye rake, a probe; vorticity on a fixed range
 * with arrows, streamlines and tracers; zoomed out so every margin shows. The flow runs a moment,
 * then is paused.
 */
async function stillScene(page, frame) {
  await T(frame, () => {
    const t = window.__TUNNEL__;
    const s = t.scene();
    const foil = { ...s.bodies[0], x: 2.6, y: 3.78, angle: 4, locked: false, enabled: true };
    t.commit({
      ...s,
      bodies: [foil, { id: 'off', name: 'Cylinder', shape: { kind: 'circle', diameter: 0.4 }, x: 5.6, y: 1.1, angle: 0, spin: 0, enabled: false, locked: false }],
      rakes: [
        { id: 'streaks', kind: 'streaks', x0: 0.9, y0: 1.4, x1: 0.9, y1: 2.6, emitters: 8, color: 1, enabled: true },
        { id: 'dye', kind: 'dye', x0: 1.1, y0: 0.6, x1: 1.1, y1: 1.2, emitters: 4, color: 3, enabled: true },
      ],
      probes: [{ id: 'probe', x: 5, y: 2.7 }],
      view: { ...s.view, field: 'vorticity', autoRange: false, min: -40, max: 40, tracers: true, arrows: true, streamlines: true, trail: 'short' },
    });
    t.select(foil.id);
    const v = t.view();
    t.setView({ cx: s.tunnel.length / 2, cy: s.tunnel.height / 2, mpp: Math.max(s.tunnel.length / (0.7 * v.w), s.tunnel.height / (0.6 * v.h)) });
  });
  await page.waitForTimeout(2500 * SLOW);
  const play = frame.locator('[data-t2d-play]');
  if ((await play.getAttribute('data-t2d-play')) === 'running') await play.click();
  await expect(play).toHaveAttribute('data-t2d-play', 'paused');
  await rafs(frame, 10);
}

/** Places on the GPU canvas (device px): the middle of the top margin, a pixel of the top wall's ring (away from the turn handle), the top-left corner. */
async function places(frame) {
  const d = await T(frame, () => window.__TUNNEL__.domain());
  expect(d.rect, 'the tunnel is on the canvas').not.toBeNull();
  expect(d.rect.walls).toEqual({ left: true, right: true, top: true, bottom: true });
  const x = Math.round(d.rect.x0 + 0.8 * (d.rect.x1 - d.rect.x0));
  return { d, margin: [x, Math.floor(d.rect.y0 / 2)], ring: [x, d.rect.y0], corner: [3, 3] };
}

/** What the screen shows at device px of the GPU canvas: RGB each, from one screenshot of the view. */
async function screenAt(page, frame, points) {
  const d = await T(frame, () => window.__TUNNEL__.domain());
  const box = await page.locator('#workspace-frame').boundingBox();
  const shot = await page.screenshot({ clip: { x: box.x + d.canvas.left, y: box.y + d.canvas.top, width: d.canvas.w, height: d.canvas.h } });
  return (await pngPixels(page, shot, points, { w: d.drawn.w, h: d.drawn.h })).at.map((p) => p.slice(0, 3));
}

/** The overlay on screen at device px: RGBA each. */
const overlayAt = (frame, points) => T(frame, (pts) => window.__TUNNEL__.overlayPixels(pts), points);

/** A screenshot of a box of the flow, inside the tunnel and away from every mark. */
async function flowBox(page, frame) {
  const at = await T(frame, () => window.__TUNNEL__.toScreen(6.9, 0.8));
  const box = await page.locator('#workspace-frame').boundingBox();
  return page.screenshot({ clip: { x: box.x + at.x - 25, y: box.y + at.y - 25, width: 50, height: 50 } });
}

/** A picture as a person takes one: the Picture button, or the C key (the focus on the button, so the view keeps its selection). Its PNG. */
async function picture(page, frame, how = 'button') {
  const pending = page.waitForEvent('download');
  const button = frame.locator('[data-t2d-picture]');
  if (how === 'button') await button.click();
  else {
    await button.focus();
    await page.keyboard.press('c');
  }
  return readFileSync(await (await pending).path());
}

/** How many pixels of two PNGs differ (RGBA), decoded in the page, and the first that does. */
function differences(page, a, b) {
  return page.evaluate(
    async ([x, y]) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        return { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data };
      };
      const [A, B] = [await decode(x), await decode(y)];
      if (A.w !== B.w || A.h !== B.h) return { size: `${A.w} x ${A.h} and ${B.w} x ${B.h}`, differing: -1 };
      let differing = 0;
      let first = null;
      for (let i = 0; i < A.d.length; i += 4) {
        if (A.d[i] !== B.d[i] || A.d[i + 1] !== B.d[i + 1] || A.d[i + 2] !== B.d[i + 2] || A.d[i + 3] !== B.d[i + 3]) {
          differing++;
          first ??= { x: (i / 4) % A.w, y: Math.floor(i / 4 / A.w), a: Array.from(A.d.slice(i, i + 4)), b: Array.from(B.d.slice(i, i + 4)) };
        }
      }
      return { size: `${A.w} x ${A.h}`, differing, first };
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

/**
 * Where a picture's cards are (device px), clear of their text: the caption's right padding, and
 * the legend's top right, between its title and its colour bar.
 */
function cardPlaces(w, h, dpr) {
  const W = w / dpr;
  const H = h / dpr;
  return [
    [Math.round((W - 11) * dpr), Math.round((H - 20) * dpr)],
    [Math.round(200 * dpr), Math.round((H - 50) * dpr)],
  ];
}

/** A picture's margin is the light view's and its cards are white: at 90 % over anything, every channel at least 229 (a dark card is under 60). */
async function expectLightPicture(page, png, dpr) {
  const { w, h } = await pngPixels(page, png, []);
  const [caption, legend] = cardPlaces(w, h, dpr);
  const px = (await pngPixels(page, png, [[3, 3], caption, legend])).at;
  expect(px[0], 'the margin').toEqual([...LIGHT_MARGIN, 255]);
  for (const [i, what] of [
    [1, 'the caption card'],
    [2, 'the legend card'],
  ]) {
    for (const c of px[i].slice(0, 3)) expect(c, `${what} ${px[i]}`).toBeGreaterThanOrEqual(229);
  }
}

/**
 * A recording played in the page: its first frame and one every 100 ms, the RGBA at the margin
 * (10, 10) and on the legend card. The card's place is worked out from the video's own size and
 * the view's CSS width `cssW`: at a device pixel ratio of 1.25 headless Chromium records the canvas
 * at its CSS size, not its device size.
 */
async function recordedFrames(page, file, cssW) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(
    async ([data, cssW]) => {
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
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const k = v.videoWidth / cssW;
      // cardPlaces' legend card, in the video's px.
      const pts = [[10, 10], [Math.round(200 * k), Math.round(v.videoHeight - 50 * k)]];
      const g = c.getContext('2d', { willReadFrequently: true });
      const frames = [];
      const sample = () => {
        g.drawImage(v, 0, 0);
        frames.push({ t: v.currentTime, at: pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)) });
      };
      // The first frame as the video shows it (drawn at loadeddata, before any frame is shown, the
      // video draws nothing), then one every 100 ms as it plays.
      await new Promise((shown) => {
        v.requestVideoFrameCallback(() => {
          sample();
          shown();
        });
        v.play().catch(() => {});
      });
      await new Promise((done) => {
        const every = setInterval(() => {
          sample();
          if (v.ended || v.paused) finish();
        }, 100);
        const stop = setTimeout(() => finish(), 20_000);
        const finish = () => {
          clearInterval(every);
          clearTimeout(stop);
          done();
        };
      });
      return { w: c.width, h: c.height, frames };
    },
    [b64, cssW],
  );
}

/** The recorded frames are all light: the margin within the codec's error of the light one, the legend card white. */
function expectLightFrames(rec) {
  expect(rec.frames.length, 'frames looked at').toBeGreaterThan(5);
  for (const f of rec.frames) {
    const [margin, card] = f.at;
    for (let k = 0; k < 3; k++) expect(Math.abs(margin[k] - LIGHT_MARGIN[k]), `the margin at ${f.t.toFixed(2)} s: ${margin}`).toBeLessThanOrEqual(8);
    for (const c of card.slice(0, 3)) expect(c, `the legend card at ${f.t.toFixed(2)} s: ${card}`).toBeGreaterThanOrEqual(220);
  }
}

/** Record for a while (`during` runs meanwhile); the WebM file. */
async function record(page, frame, during) {
  const rec = frame.locator('[data-t2d-record]');
  await rec.click();
  await expect(rec).toHaveAttribute('data-t2d-record', 'on');
  await during();
  const pending = page.waitForEvent('download');
  await rec.click();
  const dl = await pending;
  expect(dl.suggestedFilename()).toMatch(/\.webm$/);
  return dl.path();
}

/** WCAG contrast of two CSS rgb() colours. */
function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map((v) => {
      const k = Number(v) / 255;
      return k <= 0.04045 ? k / 12.92 : ((k + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The purple streak rake selected a moment (then the airfoil again): its swatch's ring and its
 * row's background, the light pixels on the overlay just outside its first end square, and the
 * overlay's pixels of the mark halo (27, 31, 39) by the switched-off cylinder's dashed outline.
 */
async function rakeSelected(frame) {
  await T(frame, () => window.__TUNNEL__.select('streaks'));
  await rafs(frame);
  const out = await T(frame, () => {
    const t = window.__TUNNEL__;
    const v = t.view();
    const d = t.domain();
    const o = document.querySelector('[data-t2d-viewport] canvas.t2d-overlay').getContext('2d');
    // The overlay's pixels (RGBA) in a box round a world point: [left, right, top, bottom] CSS px from it.
    const box = (x, y, [x0, x1, y0, y1]) => {
      const at = t.toScreen(x, y);
      const cx = (at.x - d.canvas.left) * v.dpr;
      const cy = (at.y - d.canvas.top) * v.dpr;
      const [a, b, c, e] = [Math.floor(cx + x0 * v.dpr), Math.ceil(cx + x1 * v.dpr), Math.floor(cy + y0 * v.dpr), Math.ceil(cy + y1 * v.dpr)];
      const data = o.getImageData(a, c, b - a, e - c).data;
      const px = [];
      for (let i = 0; i < data.length; i += 4) px.push(Array.from(data.slice(i, i + 4)));
      return px;
    };
    const s = t.scene();
    const rake = s.rakes.find((r) => r.id === 'streaks');
    const off = s.bodies.find((b) => b.id === 'off');
    const r = off.shape.diameter / 2 / v.mpp;
    const swatch = document.querySelector('[data-t2d-rake="streaks"].is-selected .t2d-swatch');
    return {
      ring: getComputedStyle(swatch).boxShadow,
      row: getComputedStyle(swatch.closest('.t2d-body-row')).backgroundColor,
      // Left of the square, whose rake-coloured edge is 4 to 6 CSS px out from the end.
      edge: box(rake.x0, rake.y0, [-9, -5.5, -1, 1]).filter((p) => p[3] >= 100 && Math.min(p[0], p[1], p[2]) >= 180).length,
      // Across the cylinder's leftmost point, two dash periods tall.
      halo: box(off.x, off.y, [-r - 4, -r + 4, -8, 8]).filter((p) => p[3] >= 120 && Math.abs(p[0] - 27) + Math.abs(p[1] - 31) + Math.abs(p[2] - 39) <= 12).length,
    };
  });
  await T(frame, () => {
    const t = window.__TUNNEL__;
    t.select(t.scene().bodies[0].id);
  });
  await rafs(frame);
  return out;
}

/** The stage in the frame: text below 4.5:1 on what is behind it, light backgrounds, light islands. */
const stageReport = (frame) =>
  frame.evaluate(() => {
    const rgba = (c) => {
      const m = (c.match(/[\d.]+/g) || ['0', '0', '0', '0']).map(Number);
      return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const over = (top, under) => [0, 1, 2].map((k) => top[k] * top[3] + under[k] * (1 - top[3]));
    const stage = document.querySelector('.t2d-stage');
    // What is behind an element of the stage: its backgrounds up to the stage, over white (the
    // lightest the flow under it can be).
    const behind = (el) => {
      const layers = [];
      for (let e = el; e && e !== stage; e = e.parentElement) layers.push(rgba(getComputedStyle(e).backgroundColor));
      return layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255]);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const lowContrast = [];
    const lightBackgrounds = [];
    for (const el of stage.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS') continue;
      const css = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (css.visibility === 'hidden' || css.display === 'none' || !r.width || !r.height) continue;
      const bg = rgba(css.backgroundColor);
      if (bg[3] > 0.1 && lum(bg) > 0.4) lightBackgrounds.push(`${el.tagName}.${el.className} ${css.backgroundColor}`);
      const text = el.tagName === 'INPUT' ? el.value : [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      if (!text) continue;
      const back = behind(el);
      const ink = over(rgba(css.color), back);
      const k = ratio(ink, back);
      if (k < 4.5) lowContrast.push(`"${text.slice(0, 30)}" ${css.color} on ${back.map(Math.round)}: ${k.toFixed(2)}`);
    }
    return {
      lowContrast,
      lightBackgrounds,
      islands: document.querySelectorAll('[data-theme="light"]:not([data-theme-keep])').length,
      kept: document.querySelectorAll('[data-theme="light"][data-theme-keep][hidden]').length,
      stage: getComputedStyle(stage).backgroundColor,
      texts: stage.querySelectorAll('.t2d-status span').length,
    };
  });

for (const dpr of [1, 1.25]) {
  test.describe(`at device pixel ratio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test('a picture taken in dark is the light picture, pixel for pixel, by the button and by the C key', async ({ page, request }) => {
      env.needsGpu();
      scaledTimeout(240_000);
      const frame = await openTunnel(env.host, page, await newTunnel(env.host, request, `Dark pictures ${dpr}`));
      await stillScene(page, frame);
      // Light, twice and by both ways: the scene is still, or nothing below means anything.
      const light = await picture(page, frame);
      expect(await differences(page, light, await picture(page, frame, 'key')), 'the scene is still').toMatchObject({ differing: 0 });
      await expectLightPicture(page, light, dpr);
      // Dark: the same pixels.
      await setTheme(page, frame, 'dark');
      await rafs(frame);
      expect(await differences(page, light, await picture(page, frame)), 'Picture in dark').toMatchObject({ differing: 0 });
      expect(await differences(page, light, await picture(page, frame, 'key')), 'C in dark').toMatchObject({ differing: 0 });
      // The screen is dark meanwhile: the pictures are not of the screen.
      const { margin } = await places(frame);
      expect((await overlayAt(frame, [margin]))[0]).toEqual([...DARK_MARGIN, 255]);
    });

    test('the dark screen: dark margins with a ring at the wall, the flow as in light, readable and wholly dark stage', async ({ page, request }) => {
      env.needsGpu();
      scaledTimeout(240_000);
      const frame = await openTunnel(env.host, page, await newTunnel(env.host, request, `Dark screen ${dpr}`));
      await stillScene(page, frame);
      const { margin, ring, corner } = await places(frame);
      // Light first: nothing painted on the margins, the GPU's frame and a box of the flow kept.
      expect(await overlayAt(frame, [margin, ring])).toEqual([
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]);
      expect((await screenAt(page, frame, [margin]))[0]).toEqual(LIGHT_MARGIN);
      const gpu = await T(frame, () => window.__TUNNEL__.gpuHash());
      const flow = await flowBox(page, frame);
      const swatchesLight = await frame.locator('.t2d-swatch').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
      expect(swatchesLight).toEqual(['rgb(105, 65, 198)', 'rgb(181, 71, 8)']);
      // The purple rake selected: no ring on its swatch, no light edge round its end squares, no
      // halo under the dashed outlines.
      expect(await rakeSelected(frame)).toMatchObject({ ring: 'none', edge: 0, halo: 0 });

      await setTheme(page, frame, 'dark');
      await rafs(frame);
      // The margins and the ring, on the overlay and on the screen.
      expect(await overlayAt(frame, [margin, ring, corner])).toEqual([
        [...DARK_MARGIN, 255],
        [...WALL, 255],
        [...DARK_MARGIN, 255],
      ]);
      const [m, c, w] = await screenAt(page, frame, [margin, corner, ring]);
      expect(m).toEqual(DARK_MARGIN);
      expect(c).toEqual(DARK_MARGIN);
      // One device px of ring: exact on the overlay; on the screen the same where the canvas is not
      // resampled (ratio 1), a mid grey between it and its neighbours where it is.
      if (dpr === 1) for (let k = 0; k < 3; k++) expect(Math.abs(w[k] - WALL[k]), `the ring on screen ${w}`).toBeLessThanOrEqual(3);
      else for (const k of w) expect(k, `the ring on screen ${w}`).toBeLessThan(160);
      // The GPU draws exactly what it drew in light, and the flow away from the ring shows so.
      expect(await T(frame, () => window.__TUNNEL__.gpuHash())).toEqual(gpu);
      expect(await differences(page, flow, await flowBox(page, frame)), 'the flow in dark').toMatchObject({ differing: 0 });
      // The rake swatches are the colours the rakes are drawn in, with a grey ring on the dark panel.
      const swatches = await frame.locator('.t2d-swatch').evaluateAll((els) => els.map((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).boxShadow]));
      expect(swatches.map((s) => s[0])).toEqual(swatchesLight);
      for (const [, ring] of swatches) expect(ring).toContain('rgb(154, 164, 178)');
      // The purple rake selected: its swatch's ring reads on the selected row, a light edge round its
      // end squares (purple is faint on their dark fill), a halo under the dashed outlines.
      const sel = await rakeSelected(frame);
      expect(contrast(sel.ring, sel.row), `the swatch's ring ${sel.ring} on the selected row ${sel.row}`).toBeGreaterThanOrEqual(3);
      expect(sel.edge, "light pixels round the rake's end square").toBeGreaterThan(0);
      expect(sel.halo, "the halo's pixels by the switched-off body's outline").toBeGreaterThanOrEqual(2);
      // The stage's text and backgrounds, with the shortcuts open too.
      await frame.locator('[data-t2d-picture]').focus();
      await page.keyboard.press('?');
      await expect(frame.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
      const report = await stageReport(frame);
      expect(report.texts, 'the status line is there').toBeGreaterThan(3);
      expect(report.lowContrast, 'text in the stage below 4.5:1').toEqual([]);
      expect(report.lightBackgrounds, 'light backgrounds in the stage').toEqual([]);
      expect(report.stage).toBe('rgb(27, 31, 39)');
      expect(report.islands, 'light islands not kept on purpose').toBe(0);
      expect(report.kept, 'the hidden light element the pictures are read on').toBe(1);
      await frame.locator('[data-t2d-shortcuts-close]').click();
      const theme = await T(frame, () => window.__TUNNEL__.theme());
      expect(theme.page).toBe('dark');
      expect(theme.screen.margin).toBe('#1b1f27');
      expect(theme.light.margin).toBeNull();
      expect(theme.cards).toEqual({ bg: '#ffffff', ink: '#101828' });

      // Light again: as it was.
      await setTheme(page, frame, 'light');
      await rafs(frame);
      expect(await overlayAt(frame, [margin, ring])).toEqual([
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]);
      expect((await screenAt(page, frame, [margin]))[0]).toEqual(LIGHT_MARGIN);
      expect(await T(frame, () => window.__TUNNEL__.gpuHash())).toEqual(gpu);
      expect(await differences(page, flow, await flowBox(page, frame)), 'the flow back in light').toMatchObject({ differing: 0 });
    });

    test('a change of theme shows in the next frame on the view, the stage and the panels; a pan or zoom in dark never uncovers the light margin', async ({ page, request }) => {
      env.needsGpu();
      scaledTimeout(240_000);
      const frame = await openTunnel(env.host, page, await newTunnel(env.host, request, `Dark live ${dpr}`));
      await stillScene(page, frame);
      // The frame after each change: what the overlay, the stage and the side panel show then (the
      // engine's and the overlay's frame callbacks were asked for before this one).
      await T(frame, () => {
        window.__switches = [];
        let last = document.documentElement.dataset.theme || 'light';
        new MutationObserver(() => {
          const theme = document.documentElement.dataset.theme || 'light';
          if (theme === last) return;
          last = theme;
          requestAnimationFrame(() => {
            const o = document.querySelector('[data-t2d-viewport] canvas.t2d-overlay');
            window.__switches.push({
              theme,
              overlay: Array.from(o.getContext('2d').getImageData(3, 3, 1, 1).data),
              stage: getComputedStyle(document.querySelector('.t2d-stage')).backgroundColor,
              panel: getComputedStyle(document.querySelector('.t2d-side')).backgroundColor,
            });
          });
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      });
      await setTheme(page, frame, 'dark');
      await expect.poll(() => T(frame, () => window.__switches.length)).toBe(1);
      await setTheme(page, frame, 'light');
      await expect.poll(() => T(frame, () => window.__switches.length)).toBe(2);
      expect(await T(frame, () => window.__switches)).toEqual([
        { theme: 'dark', overlay: [...DARK_MARGIN, 255], stage: 'rgb(27, 31, 39)', panel: 'rgb(27, 31, 39)' },
        { theme: 'light', overlay: [0, 0, 0, 0], stage: 'rgb(240, 242, 247)', panel: 'rgb(255, 255, 255)' },
      ]);

      // Pan and zoom in dark, a step a frame, on the plain view (no flow pixel there is the light
      // margin's colour): in every frame each pixel the GPU drew as the light margin is under the
      // overlay's opaque dark one.
      await setTheme(page, frame, 'dark');
      await T(frame, () => {
        const t = window.__TUNNEL__;
        const s = t.scene();
        t.commit({ ...s, view: { ...s.view, field: 'none' } });
      });
      await rafs(frame, 10);
      const pan = await T(frame, async () => {
        const t = window.__TUNNEL__;
        const v0 = t.view();
        const gpu = document.querySelector('[data-t2d-canvas]');
        const ov = document.querySelector('[data-t2d-viewport] canvas.t2d-overlay');
        const c = document.createElement('canvas');
        const uncovered = [];
        let margins = 0;
        const N = 60;
        for (let k = 0; k <= N; k++) {
          // After the engine's and the overlay's drawing of this frame (their loops asked first).
          await new Promise((r) => requestAnimationFrame(r));
          c.width = gpu.width;
          c.height = gpu.height;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(gpu, 0, 0);
          const a = g.getImageData(0, 0, c.width, c.height).data;
          const b = ov.getContext('2d').getImageData(0, 0, ov.width, ov.height).data;
          for (let i = 0; i < a.length; i += 4) {
            if (a[i] !== 240 || a[i + 1] !== 242 || a[i + 2] !== 247) continue;
            margins++;
            if (b[i + 3] !== 255 && uncovered.length < 8) uncovered.push({ frame: k, x: (i / 4) % c.width, y: Math.floor(i / 4 / c.width), overlay: Array.from(b.slice(i, i + 4)) });
          }
          const p = k / N;
          t.setView({ cx: v0.cx + 1.5 * Math.sin(2 * Math.PI * p), cy: v0.cy + 0.6 * Math.sin(4 * Math.PI * p), mpp: v0.mpp * (1 + 0.4 * Math.sin(6 * Math.PI * p)) });
        }
        t.setView({ cx: v0.cx, cy: v0.cy, mpp: v0.mpp });
        return { margins, uncovered };
      });
      expect(pan.margins, 'margin pixels looked at').toBeGreaterThan(10_000);
      expect(pan.uncovered, 'light margin pixels the overlay left open').toEqual([]);
    });

    test('a recording in dark stays light through theme changes; the screen never shows a light margin while it records', async ({ page, request }) => {
      env.needsFastGpu();
      scaledTimeout(240_000);
      const frame = await openTunnel(env.host, page, await newTunnel(env.host, request, `Dark recording ${dpr}`));
      await stillScene(page, frame);
      // The flow runs: each recorded frame is composed anew.
      await frame.locator('[data-t2d-play]').click();
      await expect(frame.locator('[data-t2d-play]')).toHaveAttribute('data-t2d-play', 'running');
      await setTheme(page, frame, 'dark');
      const { margin } = await places(frame);
      const screen = [];
      const watch = async (ms) => {
        for (const end = Date.now() + ms; Date.now() < end; ) {
          screen.push((await screenAt(page, frame, [margin]))[0]);
          await page.waitForTimeout(150);
        }
      };
      const file = await record(page, frame, async () => {
        await watch(1500);
        await setTheme(page, frame, 'light');
        await page.waitForTimeout(600);
        await setTheme(page, frame, 'dark');
        await watch(1200);
      });
      expect(screen.length).toBeGreaterThan(5);
      for (const px of screen) expect(px, 'the screen while recording in dark').toEqual(DARK_MARGIN);
      const view = await T(frame, () => window.__TUNNEL__.view());
      const rec = await recordedFrames(page, file, view.w);
      console.log(`recording ${rec.w} x ${rec.h}, ${rec.frames.length} frames looked at`);
      // The whole view (its size in px is the browser's choice: see recordedFrames).
      expect(Math.abs(rec.w / rec.h - view.w / view.h)).toBeLessThan(0.01);
      expectLightFrames(rec);
    });
  });
}

test.describe('with the theme dark before the tunnel opens', () => {
  /** Dark in the app's prefs, then the tunnel opened: its page is dark from the first paint. */
  async function openDark(page, request, title) {
    const r = await request.post(`${env.host.base}/api/prefs`, { data: { theme: 'dark', text_scale: 1, icon_scale: 1 } });
    expect(r.ok(), await r.text()).toBe(true);
    const frame = await openTunnel(env.host, page, await newTunnel(env.host, request, title));
    expect(await frame.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    return frame;
  }

  test('its first picture is light, while its screen is dark', async ({ page, request }) => {
    env.needsGpu();
    scaledTimeout(180_000);
    const frame = await openDark(page, request, 'Dark at open');
    // The first thing done: a picture.
    const png = await picture(page, frame);
    const view = await T(frame, () => window.__TUNNEL__.view());
    await expectLightPicture(page, png, view.dpr);
    await expect.poll(() => overlayAt(frame, [[3, 3]])).toEqual([[...DARK_MARGIN, 255]]);
    expect(await frame.locator('.t2d-stage').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(27, 31, 39)');
  });

  test('its first recorded frame is light', async ({ page, request }) => {
    env.needsFastGpu();
    scaledTimeout(180_000);
    const frame = await openDark(page, request, 'Dark at open, recorded');
    const file = await record(page, frame, () => page.waitForTimeout(1500));
    const view = await T(frame, () => window.__TUNNEL__.view());
    const rec = await recordedFrames(page, file, view.w);
    expectLightFrames(rec);
    // The first frame (the one composed as Record is pressed) above all.
    for (let k = 0; k < 3; k++) expect(Math.abs(rec.frames[0].at[0][k] - LIGHT_MARGIN[k])).toBeLessThanOrEqual(8);
  });
});
