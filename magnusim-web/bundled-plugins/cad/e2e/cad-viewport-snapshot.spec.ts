// The viewport's pictures drawn off screen and its count of the person's camera moves (the
// Assistant's view tool and camera latch build on them), in the host's sandboxed frame:
//  - handle.snapshot gives a picture of the size asked and leaves the person's view as it was:
//    the camera, the Part's saved camera, whether the view is still framed, the section view, the
//    selection and the count of camera moves are unchanged, nothing is written (the model through
//    ws.files, the Part's view through ws.data), and the canvas shows the same pixels afterwards;
//    no snapshot schedules a timer (a camera change is reported and saved only from one), and one
//    real camera move afterwards is reported once and writes the view once. The picture shows the
//    bodies (over 2 % of it), leaves a selected face unlit and a hidden body out, shows a cut's
//    hatched cap, and iso_back sees the part from back-left-top (the body at +X on the left, on
//    the right in iso); project() lands on the body it names and visibleFaceAt() finds its face.
//  - The app's own camera turns are not the person's moves: every camera call the app makes on
//    its own is recorded with its options and passes auto, and the count stays: sketch entry's
//    Normal to, the refit after Finish of a first sketch drawn past the edges (it moves the
//    camera), the new Extrude's turn to Isometric (it moves the camera), the banana's refit,
//    a reopened sketch's Normal to (it moves the camera) and its reframe once the later Extrude
//    is rolled back, and the refit after that Finish (those three find nothing to move here; a
//    refit or reframe that moves is counted only without auto: tests/viewport/camera-count.test.ts).
//    A drag, a wheel step, F, 7, a face's right-click Normal to and the Fit button each count once
//    (the handle calls among them without auto).
// Coarse facts only (SwiftShader on Linux CI): fractions and colour families, never exact pixels.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Frame, type Page } from '@playwright/test';
import { addSolid, countFileWrites, drawRectangle, fileWrites, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';
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
  /** The delays of the timers the snapshot call scheduled (a camera change to report, a save): none. */
  timers: number[];
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
      // Every timer the call schedules: a camera change is reported, and saved, only from a timer
      // (the camera's rest), so none scheduled here means none is pending from the snapshot.
      const timers: number[] = [];
      const setTimeoutWas = window.setTimeout;
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...a: unknown[]) => {
        timers.push(ms ?? 0);
        return setTimeoutWas(fn, ms, ...a);
      }) as typeof window.setTimeout;
      let r;
      try {
        r = h.snapshot(o);
      } finally {
        window.setTimeout = setTimeoutWas;
      }
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
      return { width: w, height: ht, length: px.length, mmPerPx: r.mmPerPx, drawn: drawn / n, red: red / n, redX: red ? redX / red / w : null, hatch: hatch / n, probes: seenAt, timers };
    },
    { o, probes },
  );
}

/**
 * Record each ws.data write from now on (the Part's view file goes there: the camera, folders,
 * eyes; the model goes through ws.files, which countFileWrites records).
 */
async function countDataWrites(page: Page) {
  await workspaceFrame(page).evaluate(() => {
    const w = window as unknown as W & { __dataWrites?: string[] };
    const data = w.__CAD__.services.bridge.data;
    w.__dataWrites = [];
    const write = data.write.bind(data);
    data.write = (...a: unknown[]) => {
      w.__dataWrites!.push(String(a[0]));
      return write(...a);
    };
  });
}

const dataWrites = (page: Page) => workspaceFrame(page).evaluate(() => [...((window as unknown as { __dataWrites?: string[] }).__dataWrites ?? [])]);

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
  await countDataWrites(page);
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
  // The probe is on the face the person selected (its front): red, not the pick green it has on screen.
  expect(onB!.rgb[0] - onB!.rgb[2], 'red where the red block is, its selected face unlit').toBeGreaterThan(60);

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

  // No snapshot scheduled a timer: no camera change is waiting to be reported (and saved).
  for (const [name, s] of Object.entries({ iso, hidden, back, plain, cut })) expect(s.timers, `${name}: timers the snapshot scheduled`).toEqual([]);

  // The person's view as it was: camera, saved camera, framing, section, selection, count; no camera
  // change reported and nothing written; the canvas shows the same pixels.
  await still(page);
  expect(await viewNow(page)).toEqual(before);
  expect(differs(shotBefore, await canvasShot(page)), 'the canvas after the pictures').toBeLessThan(0.002);
  const changes = () => frame.evaluate(() => (window as unknown as { __cameraChanges?: number }).__cameraChanges);
  expect(await changes()).toBe(0);
  expect(await fileWrites(page)).toEqual([]);
  expect(await dataWrites(page)).toEqual([]);
  // What would have shown a change works: one real move of the camera (a standard view, as the
  // views menu does) is reported once when it rests, and the Part's view is written once.
  await frame.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setView('top', { animate: false }));
  await expect.poll(changes, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await dataWrites(page)).length, { timeout: 30_000 }).toBe(1);
  expect(await changes()).toBe(1);
  expect(await fileWrites(page)).toEqual([]);
  expect((await viewNow(page)).saved).not.toEqual(before.saved);
  expect(seen.errors).toEqual([]);
});

/**
 * One camera call on the viewport handle: the method, whether it passed `auto`, what it returned;
 * before it, the camera's target and whether the view was still as its last framing left it.
 */
interface CameraCall {
  name: string;
  auto: boolean;
  ret: unknown;
  before: V3;
  framed: boolean;
}

/**
 * Record every camera call on the viewport handle from now on (the app looks the handle's
 * methods up at each call, so each call goes through the record), with where each method takes
 * its options (CameraCallOpts).
 */
async function recordCameraCalls(page: Page) {
  await workspaceFrame(page).evaluate(() => {
    const w = window as unknown as W & { __cameraCalls?: CameraCall[] };
    const h = w.__CAD__.services.viewport.get().handle;
    w.__cameraCalls = [];
    const optsAt: Record<string, number> = { fit: 0, setView: 1, lookAt: 2, orbitAround: 1, setCamera: 1, reframe: 0, refitIfOffScreen: 0 };
    for (const [name, i] of Object.entries(optsAt)) {
      const real = h[name];
      h[name] = (...a: unknown[]) => {
        const before = h.camera().target as V3;
        const framed = h.stats().framed as boolean;
        const ret = real.apply(h, a);
        w.__cameraCalls!.push({ name, auto: !!(a[i] as { auto?: boolean } | undefined)?.auto, ret: ret ?? null, before, framed });
        return ret;
      };
    }
  });
}

/** The camera calls recorded so far; `take` also clears them. */
const cameraCalls = (page: Page, take = false) =>
  workspaceFrame(page).evaluate((t) => {
    const calls = (window as unknown as { __cameraCalls: CameraCall[] }).__cameraCalls;
    return t ? calls.splice(0) : [...calls];
  }, take);

const called = async (page: Page, name: string) => (await cameraCalls(page)).some((c) => c.name === name);

/**
 * The app's own camera calls of one step, taken: every one passed auto, and among them those
 * named (in this order; others may come between, such as a new sketch's reframe when its first
 * build was still running as sketch mode began).
 */
async function ownCalls(page: Page, want: Partial<CameraCall>[]) {
  const calls = await cameraCalls(page, true);
  expect(calls.filter((c) => !c.auto), 'camera calls without auto').toEqual([]);
  let at = 0;
  for (const w of want) {
    const i = calls.findIndex((c, k) => k >= at && Object.entries(w).every(([key, v]) => c[key as keyof CameraCall] === v));
    expect(i, `${JSON.stringify(w)} in ${JSON.stringify(calls)}`).toBeGreaterThanOrEqual(0);
    at = i + 1;
  }
}

test("cad:viewport-camera-moves the app's own turns are not the person's camera moves; a drag, a wheel step, F, 7, Normal to and Fit are", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await recordCameraCalls(page);
  const m0 = await moves(page);
  // A first sketch drawn past the edges of the view, as the person draws one: sketch entry looks
  // down at the Top plane, and once sketch mode has ended the view refits to bring it all in (it
  // moves the camera: refitIfOffScreen answers true). Both are the app's own: auto, not counted.
  await drawRectangle(page, frame, 600, 400);
  await expect.poll(() => called(page, 'refitIfOffScreen'), { timeout: 30_000 }).toBe(true);
  await still(page);
  expect(await moves(page), "no move of the person's while it was drawn (one leaves the view unframed: no refit)").toBe(m0);
  const first = await cameraCalls(page);
  expect(first.filter((c) => c.name === 'refitIfOffScreen').map((c) => c.ret), `one refit, and it moved the camera: ${JSON.stringify(first)}`).toEqual([true]);
  await ownCalls(page, [{ name: 'lookAt' }, { name: 'refitIfOffScreen', ret: true }]);
  // Extruded 40 mm: the new Extrude seen along its direction turns the view to Isometric.
  await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-profile-list] [data-profile]')).toHaveCount(1);
  const s3 = 1 / Math.sqrt(3);
  await looksAlong(page, [s3, -s3, s3]);
  const dist = panel.locator('.nui[data-field="distance"] input');
  await dist.fill('40');
  await dist.press('Enter');
  await expect(panel.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveCount(0);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await still(page);
  await ownCalls(page, [{ name: 'setView' }]);
  expect(await moves(page)).toBe(m0);

  // The banana for scale, put beside the block: its refit is the app's own too (here nothing is
  // off screen, so it moves nothing; tests/features/scale/auto-camera.test.ts pins its options).
  await runCommand(frame, 'scale.banana');
  await expect(frame.locator('[data-layer="scale-banana"]')).toHaveCount(1);
  await expect.poll(() => called(page, 'refitIfOffScreen'), { timeout: 30_000 }).toBe(true);
  await still(page);
  await ownCalls(page, [{ name: 'refitIfOffScreen' }]);
  expect(await moves(page)).toBe(m0);
  // Taken away again: a press on it drags the banana, not the view (the drags below must orbit).
  await runCommand(frame, 'scale.banana');
  await expect(frame.locator('[data-layer="scale-banana"]')).toHaveCount(0);
  // The sketch opened again with the Extrude after it: Normal to its plane (the block is already
  // left out as sketch mode starts), then the reframe once the rebuild has rolled the Extrude back
  // (here nothing changed by then, so it leaves the camera where it is; a reframe that moves is
  // counted only without auto: tests/viewport/camera-count.test.ts); Finish refits (nothing is off
  // screen). None of them is the person's.
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"] > .tree-row').first().dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await looksAlong(page, [0, 0, 1]);
  await expect.poll(() => called(page, 'reframe'), { timeout: 60_000 }).toBe(true);
  await still(page);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await expect.poll(() => called(page, 'refitIfOffScreen'), { timeout: 30_000 }).toBe(true);
  await still(page);
  await ownCalls(page, [{ name: 'lookAt' }, { name: 'reframe' }, { name: 'refitIfOffScreen' }]);
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
  const topFace = await modelOnPage(page, [300, 200, 40]);
  await page.mouse.click(topFace[0], topFace[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="normal-to"]').click();
  await looksAlong(page, [0, 0, 1]);
  expect(await moves(page)).toBe(m0 + 5);
  await frame.locator('[data-vp-fit]').click();
  await expect.poll(() => moves(page)).toBe(m0 + 6);
  await still(page);
  // F, 7, Normal to and the Fit button (the Home view) went through the handle without auto (the
  // drag and the wheel are the view's own).
  expect((await cameraCalls(page, true)).map((c) => [c.name, c.auto])).toEqual([
    ['fit', false],
    ['setView', false],
    ['lookAt', false],
    ['setView', false],
  ]);
  // A picture off screen is not a move either.
  await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.snapshot({ view: 'iso', width: 64, height: 64, hide: [], section: null }));
  expect(await moves(page)).toBe(m0 + 6);
  expect(await cameraCalls(page)).toEqual([]);
  expect(seen.errors).toEqual([]);
});
