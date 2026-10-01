// Shared e2e steps: a fresh project, "+ New Part" through the host's own UI,
// opening the Part workspace, and collecting CSP violations / console errors
// from the page and the frame. Owner: INTEGRATE (builders may add helpers at the end).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';

export function baseUrl(): string {
  const b = process.env.CAD_E2E_BASE_URL;
  if (!b) throw new Error('CAD_E2E_BASE_URL is not set (global-setup starts the host server)');
  return b;
}

/**
 * A new, empty project (API: the same route the Home page's New project uses).
 * CAD ships off (manifest default_enabled = false): unless `cadOff`, it is
 * turned on first, the way Settings' Enable does, so "+ New Part" is there.
 */
export async function newProject(request: APIRequestContext, title = `CAD e2e ${Date.now()}`, opts: { cadOff?: boolean } = {}): Promise<string> {
  if (!opts.cadOff) await ensureCadOn(request);
  const r = await request.post(`${baseUrl()}/api/project`, { data: { title, category: 'Other', units: 'Metric' } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return String(j.id);
}

/** Records CSP violations (any frame) and console errors / page errors. */
export async function watchPage(page: Page) {
  const seen = { csp: [] as string[], errors: [] as string[] };
  await page.context().addInitScript(() => {
    document.addEventListener(
      'securitypolicyviolation',
      (e) => console.error(`[csp-violation] ${e.effectiveDirective} ${e.blockedURI} in ${location.href}`),
      true,
    );
  });
  page.on('console', (m) => {
    const t = m.text();
    const url = m.location().url || '';
    if (t.startsWith('[csp-violation]')) seen.csp.push(t);
    // Real Chrome/Edge ask the host page's origin for /favicon.ico (the app has
    // none; bundled Chromium does not ask). Not the workspace's doing.
    else if (m.type() === 'error' && !/^https?:\/\/[^/]+\/favicon\.ico$/.test(url)) seen.errors.push(`${t} (${url || 'no url'})`);
  });
  page.on('pageerror', (e) => seen.errors.push(String(e)));
  return seen;
}

export async function openProject(page: Page, projectId: string) {
  await page.goto(`${baseUrl()}/#/p/${projectId}`);
  await page.waitForFunction((id) => (window as unknown as { __CFD_PROJECT_READY__?: string }).__CFD_PROJECT_READY__ === id, projectId, { timeout: 90_000 });
}

/**
 * STUDIES "+ New Part" -> the host's name prompt -> Create. The prompt offers the
 * first free "Part N" (`offered`: "Part 1" in a project with no Part yet), and the
 * host then opens the new Part in its workspace by itself, with no click on its row:
 * the overlay shows, the address names the new Part, and the header shows its title.
 * Returns the new row (to reopen the Part later with openPart); partOpened() waits
 * for the workspace to be ready.
 */
export async function newPartFromTree(page: Page, title = 'Part 1', { offered = 'Part 1' }: { offered?: string } = {}) {
  const btn = page.locator('#plugin-studies-section [data-plugin-study-new="cad:part"]');
  await expect(btn).toHaveText('+ New Part');
  await btn.click();
  const modal = page.locator('#modal-prompt');
  await expect(modal).toBeVisible();
  await expect(page.locator('#pm-input')).toHaveValue(offered);
  await page.locator('#pm-input').fill(title);
  await page.locator('#pm-confirm').click();
  await expect(modal).toBeHidden();
  const row = page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: title }) });
  await expect(row).toHaveCount(1);
  const studyId = await row.getAttribute('data-plugin-study');
  expect(studyId, 'the new row names its study').toBeTruthy();
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  const id = encodeURIComponent(String(studyId)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/ws/cad/part/${id}$`));
  await expect(page.locator('#workspace-overlay [data-ws-title]')).toHaveText(title);
  return row;
}

/** The Part workspace that is opening (no click): wait for it to connect and for the kernel handshake. */
export async function partOpened(page: Page): Promise<FrameLocator> {
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('[data-cad-app]')).toBeVisible();
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-kernel', 'ready', { timeout: 60_000 });
  return frame;
}

/** Click a Part row (a Part made earlier) and wait for the workspace to connect and the kernel handshake. */
export async function openPart(page: Page, row: ReturnType<Page['locator']>): Promise<FrameLocator> {
  await row.locator('> .tree-row').click();
  return partOpened(page);
}

/** The workspace frame's Page-level handle (for evaluate()). */
export function workspaceFrame(page: Page) {
  const f = page.frames().find((fr) => /\/plugins\/cad\/workspace\//.test(fr.url()));
  if (!f) throw new Error('the CAD workspace frame is not open');
  return f;
}

// ---- review round 2: leaving with a change that waits on the save budget

type Frame = FrameLocator;

/** A history row by its exact name. */
export const featureRowNamed = (frame: Frame, name: string) =>
  frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${name}$`) }) });

/** Names in the history, with " (S)" after a suppressed feature: what the user sees, in one string. */
export const historyState = (frame: Frame) =>
  frame
    .locator('[data-cad-tree] [data-feature-row]')
    .evaluateAll((rows) => rows.map((r) => (r.querySelector(':scope > .tree-row .tl')?.textContent ?? '') + (r.getAttribute('data-suppressed') === '1' ? ' (S)' : '')).join(', '));

// ---- host API 1.2 (P1.5): CAD ships off; leaving with unsaved work asks

/** CAD's row in GET /api/plugins (null when it is not listed). */
export async function cadPluginRow(request: APIRequestContext): Promise<Record<string, unknown> | null> {
  const list = await (await request.get(`${baseUrl()}/api/plugins`)).json();
  return ((list.plugins || []) as Record<string, unknown>[]).find((p) => p.key === 'cad') ?? null;
}

/** Turn CAD on the way Settings' Enable does (POST /api/plugins/cad/enable), then reload the registry. */
export async function ensureCadOn(request: APIRequestContext): Promise<void> {
  const row = await cadPluginRow(request);
  if (row && row.status === 'enabled') return;
  const on = await request.post(`${baseUrl()}/api/plugins/cad/enable`, { data: {} });
  expect(on.ok(), await on.text()).toBe(true);
  const reload = await request.post(`${baseUrl()}/api/worker`, { data: { method: 'registry.reload', params: {} } });
  expect(reload.ok()).toBe(true);
  expect((await cadPluginRow(request))?.status).toBe('enabled');
}

/**
 * Put CAD back the way a fresh install has it: no choice remembered on this PC
 * (neither plugins.enabled nor plugins.disabled names it in the server's local
 * JSON), then reload the registry. CAD is then off by its manifest alone; the
 * caller asserts that from what the user sees first (Settings > Plugins), then
 * from the API (P1.5 review round 1: the check here failed before any of it).
 */
export async function resetCadToDefault(request: APIRequestContext): Promise<void> {
  const prefs = process.env.CAD_E2E_PREFS;
  if (!prefs) throw new Error('CAD_E2E_PREFS is not set: the off-by-default test needs a host server this run started (global-setup)');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const json = JSON.parse(readFileSync(prefs, 'utf8'));
  const plugins = json.plugins && typeof json.plugins === 'object' ? json.plugins : {};
  for (const k of ['enabled', 'disabled']) if (Array.isArray(plugins[k])) plugins[k] = plugins[k].filter((x: unknown) => x !== 'cad');
  json.plugins = plugins;
  writeFileSync(prefs, JSON.stringify(json));
  const reload = await request.post(`${baseUrl()}/api/worker`, { data: { method: 'registry.reload', params: {} } });
  expect(reload.ok()).toBe(true);
  // CAD is listed (as a fresh install lists it); whether it is off is the caller's assertion.
  expect(await cadPluginRow(request)).not.toBeNull();
}

/**
 * Hold every ws.files write's commit (the step that replaces the file) until
 * release(): the model's save stays on its way, so the page is dirty for as
 * long as the test needs (deterministic, instead of racing a 20 ms save).
 * abort() fails the held commits instead (the page left: the host ends them).
 */
export async function holdCommits(page: Page) {
  const pattern = '**/api/plugin-files/uploads/*/commit*';
  const held: { route: import('@playwright/test').Route }[] = [];
  let open = true;
  await page.route(pattern, async (route) => {
    if (!open) return route.continue();
    held.push({ route });
  });
  // The held routes are answered before the handler goes: unrouting first would let them through.
  const end = async (how: 'continue' | 'abort') => {
    open = false;
    for (const h of held.splice(0)) await (how === 'continue' ? h.route.continue() : h.route.abort()).catch(() => {});
    await page.unroute(pattern);
  };
  return {
    held: () => held.length,
    release: () => end('continue'),
    abort: () => end('abort'),
  };
}

/**
 * The keyboard moves out of the Part to the host's header (its title button, as
 * Shift+Tab out of the page would). The host gives it back to the page by itself
 * only when one of its dialogs or panels really closes (a change from shown to
 * hidden); a header control keeps it until then.
 */
export async function headerTakesKeyboard(page: Page): Promise<void> {
  await page.locator('#workspace-overlay [data-ws-title]').focus();
  await expect.poll(() => workspaceFrame(page).evaluate(() => document.hasFocus())).toBe(false);
}

/** The app's "Leave without saving?" question about the open Part, as the user reads it. */
export async function expectLeaveQuestion(page: Page, partTitle = 'Part 1'): Promise<void> {
  const modal = page.locator('#modal-confirm');
  await expect(modal).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Leave without saving?');
  await expect(page.locator('#cf-copy')).toHaveText(`Magnusim CAD: Changes to ${partTitle} are not saved yet. Leaving discards them.`);
  await expect(page.locator('#cf-confirm')).toHaveText('Leave');
  // Stay has the keyboard, so Enter (like Escape) keeps the work; Leave takes a click.
  await expect(page.locator('#cf-cancel')).toHaveText('Stay');
  await expect(page.locator('#cf-cancel')).toBeFocused();
}

/** Answer the app's question with a click: Leave, or stay (Stay; Cancel on "Turn off"). */
export async function answerLeave(page: Page, leave: boolean): Promise<void> {
  await page.locator(leave ? '#cf-confirm' : '#cf-cancel').click();
  await expect(page.locator('#modal-confirm')).toBeHidden();
}
