// The viewport's pictures drawn off screen and its count of the person's camera moves (the
// Assistant's view tool and camera latch build on them), in the host's sandboxed frame:
//  - handle.snapshot gives a picture of the size asked and leaves the person's view as it was:
//    the camera, the Part's saved camera, whether the view is still framed, the section view, the
//    selection and the count of camera moves are unchanged, nothing is written, and the canvas
//    shows the same pixels afterwards. The picture shows the bodies (over 2 % of it), leaves a
//    hidden body out, shows a cut's hatched cap, and iso_back sees the part from back-left-top
//    (the body at +X on the left, on the right in iso); project() lands on the body it names and
//    visibleFaceAt() finds its face there.
//  - The app's own camera turns are not the person's moves: sketch entry's Normal to, the new
//    Extrude's turn to Isometric, the refit after Finish sketch, the banana's refit and a reopened
//    sketch's reframe. A drag, a wheel step, F, 7, a face's right-click Normal to and the Fit
//    button each count once.
// Coarse facts only (SwiftShader on Linux CI): fractions and colour families, never exact pixels.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, countFileWrites, drawBlock, fileWrites, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

/** A snapshot's options, as ViewportHandle.snapshot takes them. */
interface Shot {
  view: 'iso' | 'iso_back' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
  width: number;
  height: number;
  hide: string[];
  section: { plane: 'top' | 'front' | 'right'; offset: number; flip: boolean } | null;
}

/** What a picture shows, counted in the frame (the triad's corner left out). */
interface Seen {
  width: number;
  height: number;
  length: number;
  mmPerPx: number;
  /** Fraction of the picture that is not the background. */
  drawn: number;
  /** Fraction in the red body's colour family, and where its pixels are across (0 left .. 1 right). */
  red: number;
  redX: number | null;
  /** Fraction in a section cap's hatch colour. */
  hatch: number;
  /** At each probe's projected pixel: its colour and the face of the probe's body seen there. */
  probes: ({ rgb: [number, number, number]; face: number | null } | null)[];
}

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** No transition running, every picking structure built, the sketch solver idle, two more frames. */
async function still(page: Page) {
  const f = workspaceFrame(page);
  await f.waitForFunction(
    () => {
      const s = (window as unknown as W).__CAD__.services;
      const v = s.viewport.get().handle?.state.get();
      return !!v && !v.animating && v.bvhPending === 0 && s.doc.state.get().rebuild.status !== 'running';
    },
    null,
    { timeout: 60_000 },
  );
  await f.evaluate(async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

const moves = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.userCameraMoves() as number);

/** The person's view as the viewport and the Part keep it. */
const viewNow = (page: Page) =>
  workspaceFrame(page).evaluate(() => {
    const s = (window as unknown as W).__CAD__.services;
    const h = s.viewport.get().handle;
    const v = h.state.get();
    return {
      camera: h.camera(),
      saved: s.doc.state.get().view.camera ?? null,
      framed: h.stats().framed,
      moves: h.userCameraMoves(),
      section: v.section,
      display: v.display,
      hover: v.hover ? v.hover.item : null,
      selection: s.selection.get().items,
    };
  });

/** The camera's view direction (unit, from the target to the camera). */
const viewDir = (page: Page) =>
  workspaceFrame(page).evaluate(() => {
    const c = (window as unknown as W).__CAD__.services.viewport.get().handle.camera();
    const d = [0, 1, 2].map((k) => c.position[k] - c.target[k]);
    const l = Math.hypot(...d);
    return d.map((x) => x / l) as V3;
  });

async function looksAlong(page: Page, n: V3) {
  const s = Math.hypot(...n);
  await expect.poll(async () => (await viewDir(page)).reduce((a, v, i) => a + (v * n[i]) / s, 0), { timeout: 30_000 }).toBeGreaterThan(0.9999);
}

/** Draw a picture and count what it shows, in the frame (the pixels never leave it). */
function picture(frame: Frame, o: Shot, probes: { p: V3; body: string }[] = []): Promise<Seen> {
  return frame.evaluate(
    ({ o, probes }) => {
      const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
      const r = h.snapshot(o);
      const px = r.rgba as Uint8ClampedArray;
      const w = r.width as number;
      const ht = r.height as number;
      // The triad sits in the bottom-right corner (red X arrow): left out of the counts.
      const corner = Math.round(Math.min(72, Math.min(w, ht) * 0.2)) + 16;
      const near = (k: number, c: number[], t: number) => Math.abs(px[k] - c[0]) <= t && Math.abs(px[k + 1] - c[1]) <= t && Math.abs(px[k + 2] - c[2]) <= t;
      let n = 0;
      let drawn = 0;
      let red = 0;
      let redX = 0;
      let hatch = 0;
      for (let y = 0; y < ht; y++)
        for (let x = 0; x < w; x++) {
          if (x >= w - corner && y >= ht - corner) continue;
          const k = 4 * (y * w + x);
          n++;
          if (!near(k, [0xf0, 0xf2, 0xf7], 4)) drawn++;
          if (px[k] > px[k + 1] + 60 && px[k] > px[k + 2] + 60) {
            red++;
            redX += x;
          }
          // A cap faces the viewer: the body colour lit straight on (x 1.16), its hatch at 0.62 of that.
          if (near(k, [136, 145, 158], 8)) hatch++;
        }
      const seenAt = probes.map(({ p, body }) => {
        const s = r.project(p) as [number, number] | null;
        if (!s) return null;
        const x = Math.min(w - 1, Math.max(0, Math.floor(s[0])));
        const y = Math.min(ht - 1, Math.max(0, Math.floor(s[1])));
        const k = 4 * (y * w + x);
        return { rgb: [px[k], px[k + 1], px[k + 2]] as [number, number, number], face: r.visibleFaceAt(body, s[0], s[1]) as number | null };
      });
      return { width: w, height: ht, length: px.length, mmPerPx: r.mmPerPx, drawn: drawn / n, red: red / n, redX: red ? redX / red / w : null, hatch: hatch / n, probes: seenAt };
    },
    { o, probes },
  );
}

/** The middle of the canvas, clear of the tree, the toolbar, the dock and the triad: as the page shows it. */
async function canvasShot(page: Page): Promise<Buffer> {
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  const c = await workspaceFrame(page).evaluate(() => {
    const r = document.querySelector('[data-cad-canvas]')!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  return page.screenshot({ clip: { x: box.x + c.x + c.width * 0.42, y: box.y + c.y + c.height * 0.25, width: c.width * 0.4, height: c.height * 0.45 } });
}

/** Fraction of pixels that differ by more than a few levels in a channel. */
function differs(a: Buffer, b: Buffer): number {
  const x = PNG.decode(a);
  const y = PNG.decode(b);
  expect([y.width, y.height]).toEqual([x.width, x.height]);
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) if ([0, 1, 2].some((k) => Math.abs(x.data[i + k] - y.data[i + k]) > 3)) n++;
  return n / (x.width * x.height);
}

test('cad:viewport-snapshot a picture drawn off screen leaves the view as it was and shows what was asked', async ({ page, request }) => {
  const { seen } = await freshPart(page, request);
  const frame = workspaceFrame(page);
  // Two blocks: the grey one at the origin, a red one at +X.
  const a = await addSolid(page, { size: [20, 20, 20] });
  const b = await addSolid(page, { at: [40, 0, 0], size: [20, 20, 20] });
  await frame.evaluate((id) => (window as unknown as W).__CAD__.services.doc.setBodyColor(id, '#d02828'), b.body);
  // The person's own section view (both blocks cut at z = 15, the lower parts kept) and a selected
  // face: the red block's front.
  await frame.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setSection({ on: true, plane: 'origin:top', offset: 15 }));
  await still(page);
  const front = await modelOnPage(page, [50, 0, 7]);
  await page.mouse.click(front[0], front[1]);
  await page.mouse.move(5, 5);
  await expect.poll(() => frame.evaluate(() => (window as unknown as W).__CAD__.services.selection.get().items.length)).toBe(1);
  await still(page);
  // Everything saved (the colour), then count what is written from here.
  await expect.poll(() => frame.evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().save.state), { timeout: 30_000 }).toBe('saved');
  const before = await viewNow(page);
  expect(before.section.on).toBe(true);
  await frame.evaluate(() => {
    const w = window as unknown as W & { __cameraChanges?: number };
    w.__cameraChanges = 0;
    w.__CAD__.services.viewport.get().handle.onCameraChange(() => (w.__cameraChanges = (w.__cameraChanges ?? 0) + 1));
  });
  await countFileWrites(page);
  const shotBefore = await canvasShot(page);

  // Iso, both blocks: the size asked, the bodies drawn, the red one on the right.
  const iso = await picture(frame, { view: 'iso', width: 320, height: 240, hide: [], section: null }, [
    { p: [10, 0, 10], body: a.body! },
    { p: [50, 0, 10], body: b.body! },
  ]);
  expect([iso.width, iso.height, iso.length]).toEqual([320, 240, 320 * 240 * 4]);
  expect(iso.mmPerPx).toBeGreaterThan(0);
  expect(iso.drawn, 'the bodies fill part of the picture').toBeGreaterThan(0.02);
  expect(iso.red, 'the red block shows').toBeGreaterThan(0.01);
  expect(iso.redX!).toBeGreaterThan(0.5);
  // project() lands on each block's front face, and visibleFaceAt finds that block's face there.
  const [onA, onB] = iso.probes;
  expect(onA && onA.face).not.toBeNull();
  expect(onA!.rgb[0] - onA!.rgb[2], 'grey, not red, where the grey block is').toBeLessThan(20);
  expect(onB && onB.face).not.toBeNull();
  expect(onB!.rgb[0] - onB!.rgb[2], 'red where the red block is').toBeGreaterThan(60);

  // The red block hidden: its colour is gone (the picture frames the grey one alone).
  const hidden = await picture(frame, { view: 'iso', width: 320, height: 240, hide: [b.body!], section: null }, [{ p: [50, 0, 10], body: b.body! }]);
  expect(hidden.red, 'the hidden body is left out').toBeLessThan(iso.red * 0.05);
  expect(hidden.drawn).toBeGreaterThan(0.02);
  expect(hidden.probes[0] === null || hidden.probes[0].face === null).toBe(true);

  // iso_back looks from back-left-top: the red block at +X is now on the left.
  const back = await picture(frame, { view: 'iso_back', width: 320, height: 240, hide: [], section: null });
  expect(back.drawn).toBeGreaterThan(0.02);
  expect(back.red).toBeGreaterThan(0.01);
  expect(back.redX!).toBeLessThan(0.5);

  // A cut through both blocks at half height, seen from the top: the caps' hatch shows; without it, none.
  const plain = await picture(frame, { view: 'top', width: 320, height: 240, hide: [], section: null });
  const cut = await picture(frame, { view: 'top', width: 320, height: 240, hide: [], section: { plane: 'top', offset: 10, flip: false } });
  expect(cut.hatch, 'the hatched cap shows').toBeGreaterThan(0.01);
  expect(cut.hatch).toBeGreaterThan(plain.hatch * 5);

  // The person's view as it was: camera, saved camera, framing, section, selection, count; no camera
  // change reported and nothing written; the canvas shows the same pixels.
  await still(page);
  expect(await viewNow(page)).toEqual(before);
  expect(differs(shotBefore, await canvasShot(page)), 'the canvas after the pictures').toBeLessThan(0.002);
  // A camera change would be reported after it rests (400 ms) and saved after that: give both time.
  await page.waitForTimeout(1500);
  expect(await frame.evaluate(() => (window as unknown as { __cameraChanges?: number }).__cameraChanges)).toBe(0);
  expect(await fileWrites(page)).toEqual([]);
  expect(await viewNow(page)).toEqual(before);
  expect(seen.errors).toEqual([]);
});

/** Open the history's sketch again (a double-click on its row), as the person does. */
async function reopenSketch(page: Page, frame: FrameLocator) {
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"] > .tree-row').first().dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await still(page);
}

test("cad:viewport-camera-moves the app's own turns are not the person's camera moves; a drag, a wheel step, F, 7, Normal to and Fit are", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const m0 = await moves(page);
  // A block drawn as the person draws one: sketch entry looks down at the Top plane, Finish refits,
  // and the new Extrude seen along its direction turns to Isometric. None of them is the person's.
  await drawBlock(page, frame, 30, 20, 10);
  await still(page);
  const s3 = 1 / Math.sqrt(3);
  await looksAlong(page, [s3, -s3, s3]);
  expect(await moves(page)).toBe(m0);
  // The banana for scale: put beside the block, the view refits by itself.
  await runCommand(frame, 'scale.banana');
  await expect(frame.locator('[data-layer="scale-banana"]')).toHaveCount(1);
  await still(page);
  expect(await moves(page)).toBe(m0);
  // Taken away again: a press on it drags the banana, not the view (the drags below must orbit).
  await runCommand(frame, 'scale.banana');
  await expect(frame.locator('[data-layer="scale-banana"]')).toHaveCount(0);
  // The sketch opened again with the Extrude after it: Normal to its plane, then the reframe once the
  // Extrude is rolled back; Finish refits. Still none of the person's.
  await reopenSketch(page, frame);
  await looksAlong(page, [0, 0, 1]);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await still(page);
  expect(await moves(page)).toBe(m0);

  // The person's moves: each counts once.
  const vp = (await page.locator('#workspace-frame').boundingBox())!;
  const mid: [number, number] = [vp.x + vp.width * 0.62, vp.y + vp.height * 0.5];
  await page.mouse.move(...mid);
  await page.mouse.down();
  await page.mouse.move(mid[0] + 80, mid[1] + 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => moves(page)).toBe(m0 + 1);
  await still(page);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => moves(page)).toBe(m0 + 2);
  await page.keyboard.press('f');
  await expect.poll(() => moves(page)).toBe(m0 + 3);
  await still(page);
  await page.keyboard.press('7');
  await expect.poll(() => moves(page)).toBe(m0 + 4);
  await still(page);
  // The block's top face, right-clicked: Normal to.
  const topFace = await modelOnPage(page, [15, 10, 10]);
  await page.mouse.click(topFace[0], topFace[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="normal-to"]').click();
  await looksAlong(page, [0, 0, 1]);
  expect(await moves(page)).toBe(m0 + 5);
  await frame.locator('[data-vp-fit]').click();
  await expect.poll(() => moves(page)).toBe(m0 + 6);
  await still(page);
  // A picture off screen is not a move either.
  await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.snapshot({ view: 'iso', width: 64, height: 64, hide: [], section: null }));
  expect(await moves(page)).toBe(m0 + 6);
  expect(seen.errors).toEqual([]);
});
