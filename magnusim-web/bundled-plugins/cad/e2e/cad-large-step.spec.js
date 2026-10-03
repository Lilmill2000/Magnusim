// The large STEP (opt-in: CAD_E2E_BIG_STEP=<path to 8m0119333_V12.step>, 113 MB,
// docs/p2p3-plan.md §5.4): imported through the UI (Import STEP, the browser's
// file picker) with progress (upload percent, then "Reading <file> · N s"
// counting, then writing and storing the healed shapes), 11,776 faces, the
// volume on request, the host page staying responsive throughout (a round trip
// to the host page under 50 ms), the healed BREP stored in the project, and a
// reopen that reads the stored BREP only (no import_step, no heal). Every time
// is recorded (console line, test annotations and large-step-times.json in the
// test's output folder). Daniel's file is read where it is, never copied; set
// but missing, the test fails with the path.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { baseUrl, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const BIG = process.env.CAD_E2E_BIG_STEP || '';
const HERE = dirname(fileURLToPath(import.meta.url));
const REF = JSON.parse(readFileSync(resolve(HERE, '..', 'fixtures', 'kernel', 'reference.json'), 'utf8')).large_step;
const SHOTS = process.env.CAD_E2E_SHOTS || '';

const tb = (frame) => frame.locator('[data-cad-toolbar]');
const panel = (frame) => frame.locator('[data-cad-panel]');
const cad = (page, fn, arg) => workspaceFrame(page).evaluate(fn, arg);

test.skip(!BIG, 'opt-in: set CAD_E2E_BIG_STEP to the 113 MB STEP (8m0119333_V12.step) to run it');

test('cad:large-step the 113 MB STEP imports through the UI with progress, 11,776 faces, the host stays responsive, the BREP is stored, and a reopen does not re-heal', async ({ page, request }) => {
  test.setTimeout(1_200_000);
  expect(existsSync(BIG), `CAD_E2E_BIG_STEP is set but there is no file at ${BIG}`).toBe(true);
  const fileName = BIG.split(/[\\/]/).pop();
  const bytes = statSync(BIG).size;
  const times = { file: fileName, bytes, browser: test.info().project.name };
  // Every op the frame's kernel worker is asked for, from the first moment of every load.
  await page.context().addInitScript(() => {
    window.__kernelOps = [];
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.type === 'call' && msg.op) window.__kernelOps.push(msg.op);
      return orig.call(this, msg, ...rest);
    };
  });
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');

  // The host page's responsiveness while the import runs, three ways: its event loop's lag (a 10 ms
  // timer in the host page: a header click waits as long), its long tasks (its own, and its frame's,
  // which share its thread where the frame is not isolated), and a round trip into it every 100 ms.
  await page.evaluate(() => {
    window.__lag = [];
    window.__longTasks = [];
    let last = performance.now();
    window.__lagTimer = setInterval(() => {
      const now = performance.now();
      window.__lag.push(Math.max(0, now - last - 10));
      last = now;
    }, 10);
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longTasks.push({ name: e.name, ms: Math.round(e.duration) });
    }).observe({ type: 'longtask', buffered: false });
  });
  const pings = [];
  let pinging = true;
  const pinger = (async () => {
    while (pinging) {
      const t0 = performance.now();
      await page.evaluate(() => document.querySelector('#workspace-overlay [data-ws-back]')?.textContent ?? '');
      pings.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  // What the progress line says, as it changes (recorded in the frame).
  await cad(page, () => {
    window.__stages = [];
    const seenText = new Set();
    const note = () => {
      const el = document.querySelector('[data-import-stage]');
      const t = el?.textContent;
      if (t && !seenText.has(t)) {
        seenText.add(t);
        window.__stages.push({ t, at: performance.now() });
      }
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  const t0 = performance.now();
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(BIG);
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText(`Imported 1 (${fileName})`);
  await expect(p.locator('[data-import-progress]')).toBeVisible();
  await expect(p.locator('[data-import-stage]')).toHaveText(/^Reading .* · \d+ s$/, { timeout: 300_000 });
  times.upload_ms = Math.round(performance.now() - t0);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'large-step-reading.png') });
  }
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 600_000 });
  // The Faces cell is never blank: "…" while the part is rebuilt, then the count (review P2/P3 round 1:
  // it was empty while "Rebuilding…" ran).
  const facesFirst = await p.locator('[data-import-bodies] tbody td').nth(2).textContent();
  expect(facesFirst).toMatch(new RegExp(`^(…|${REF.healed_counts.faces.toLocaleString('en-US')})$`));
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  times.import_ms = Math.round(performance.now() - t0);
  const stages = await cad(page, () => window.__stages.map((s) => s.t));
  times.stages = stages;
  // Upload percent, then the read counting its seconds, then writing and storing the healed shapes.
  expect(stages.some((t) => new RegExp(`^Uploading ${fileName.replace(/\./g, '\\.')} · ([1-9]\\d?|100)%$`).test(t)), stages.join(' | ')).toBe(true);
  expect(stages.filter((t) => /^Reading .* · \d+ s$/.test(t)).length, stages.join(' | ')).toBeGreaterThan(2);
  expect(stages.some((t) => /^Storing the healed shapes · \d+%$/.test(t)), stages.join(' | ')).toBe(true);
  // 11,776 faces, one solid, valid; a large file is healed while it is read.
  await expect(p.locator('[data-import-bodies] tbody tr')).toHaveCount(1);
  await expect(p.locator('[data-import-bodies] tbody td').nth(1)).toHaveText('Solid');
  await expect(p.locator('[data-import-bodies] tbody td').nth(2)).toHaveText(REF.healed_counts.faces.toLocaleString('en-US'));
  await expect(p.locator('[data-import-bodies] tbody td').nth(3)).toHaveText('Valid');
  await expect(p.getByText('Large file: healed while it was read.')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'large-step-imported.png') });
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  // Until the part is on screen (its first frames are drawn too).
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  await expect(frame.locator('[data-chip="size"], [data-chip="volume"]').first()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(3000);
  pinging = false;
  await pinger;
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return { n: s.length, p50: Math.round(s[Math.floor(s.length / 2)]), p95: Math.round(s[Math.ceil(s.length * 0.95) - 1]), max: Math.round(s[s.length - 1]) };
  };
  const host = await page.evaluate(() => {
    clearInterval(window.__lagTimer);
    return { lag: window.__lag, long: window.__longTasks };
  });
  times.host_round_trips = stats(pings);
  times.host_lag = stats(host.lag);
  times.host_long_tasks = host.long;
  times.renderer = await cad(page, () => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return gl ? String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'none';
  });
  const own = host.long.filter((t) => t.name === 'self' && t.ms > 50);
  const frames = host.long.filter((t) => t.name !== 'self');
  test.info().annotations.push({ type: 'responsiveness', description: JSON.stringify({ round_trips: times.host_round_trips, lag: times.host_lag, long_tasks: host.long, renderer: times.renderer }) });
  expect(pings.length).toBeGreaterThan(50);
  // The host page's own work never holds its thread past 50 ms (the healed BREP's 16 MB chunks did,
  // ~160 ms each, when they went to storage as ArrayBuffers), and a round trip into it is quick.
  expect(own, `the host page's own long tasks: ${JSON.stringify(own)}`).toEqual([]);
  expect(times.host_round_trips.p95, JSON.stringify(times.host_round_trips)).toBeLessThan(50);
  // Real Chrome and Edge run the sandboxed frame in its own process: nothing the frame does holds the
  // host's thread, so its event loop never waits 50 ms. Bundled Chromium does not isolate the frame
  // (ARCHITECTURE.md §8): there the frame's own long tasks (drawing the 553k-triangle part with its
  // software renderer, SwiftShader) run on the host's thread too; they are recorded, not failed.
  if (test.info().project.name !== 'chromium') {
    expect(frames, `long tasks of the frame on the host's thread: ${JSON.stringify(frames)}`).toEqual([]);
    expect(times.host_lag.max, `the host page's event loop lag: ${JSON.stringify(times.host_lag)}`).toBeLessThan(50);
  }

  // The part on screen: the volume on request (a large part is measured when asked).
  await expect(frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  const chip = frame.locator('[data-chip="volume"]');
  await expect(chip).toContainText('Not measured yet', { timeout: 120_000 });
  const tm = performance.now();
  await chip.locator('[data-chip-action="Measure"]').click();
  await expect(chip.locator('[data-volume-mm3]')).toBeVisible({ timeout: 300_000 });
  times.measure_ms = Math.round(performance.now() - tm);
  const v = Number(await chip.locator('[data-volume-mm3]').getAttribute('data-volume-mm3'));
  expect(Math.abs(v / REF.volume - 1)).toBeLessThan(1e-6);
  if (SHOTS) {
    await page.keyboard.press('f');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOTS, 'large-step-part.png') });
  }

  // The healed BREP is stored in the project (its size recorded).
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 120_000 });
  const listed = await (await request.get(`${baseUrl()}/api/plugin-files/list?${new URLSearchParams({ project_id: projectId, plugin: 'cad', prefix: 'studies' })}`)).json();
  const brep = listed.files.find((f) => /\/imports\/[0-9a-f]{64}\/healed-.*\.brep$/.test(f.rel));
  const source = listed.files.find((f) => /\/imports\/[0-9a-f]{64}\/source\.step$/.test(f.rel));
  expect(brep, JSON.stringify(listed.files.map((f) => f.rel))).toBeTruthy();
  expect(source?.size).toBe(bytes);
  times.brep_bytes = brep.size;
  expect(brep.size).toBeGreaterThan(10 * 1024 * 1024);
  const ops = await cad(page, () => window.__kernelOps);
  expect(ops).toContain('import_step');
  expect(ops).toContain('brep_write');

  // Back and reopen: the stored BREP only (no import_step, no heal), the part as it was.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const t1 = performance.now();
  const again = await openPart(page, row);
  const imported = again.locator('[data-cad-tree] [data-feature-row]').first();
  await expect(imported).toHaveAttribute('data-state', 'ok', { timeout: 300_000 });
  await expect(again.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  times.reopen_ms = Math.round(performance.now() - t1);
  const reopenOps = await cad(page, () => window.__kernelOps);
  expect(reopenOps).toContain('brep_read');
  expect(reopenOps).not.toContain('import_step');
  expect(reopenOps).not.toContain('heal');
  await imported.locator('> .tree-row').dblclick();
  await expect(panel(again).locator('[data-import-output="brep"]')).toHaveText(/^Loaded from the stored healed shapes in (\d+ ms|\d+\.\d s)$/);
  await expect(panel(again).locator('[data-import-bodies] tbody td').nth(2)).toHaveText(REF.healed_counts.faces.toLocaleString('en-US'));
  // Stored with the Part (it said so only in the importing session before).
  await expect(panel(again).getByText('Large file: healed while it was read.')).toBeVisible();
  times.reopen_text = await panel(again).locator('[data-import-output="brep"]').textContent();
  await panel(again).locator('[data-panel-done]').click();

  const line = `large-step ${JSON.stringify(times)}`;
  console.log(`[cad-large-step] ${line}`);
  test.info().annotations.push({ type: 'times', description: line });
  mkdirSync(test.info().outputDir, { recursive: true });
  writeFileSync(join(test.info().outputDir, 'large-step-times.json'), JSON.stringify(times, null, 2));
  if (process.env.CAD_E2E_TIMES) writeFileSync(process.env.CAD_E2E_TIMES, JSON.stringify(times, null, 2));
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
