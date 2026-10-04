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

/**
 * Click a Part row (a Part made earlier) and wait for the workspace to connect and the kernel
 * handshake. Since exit sync (host API 1.6) leaving a changed Part updates its geometry, and the
 * landing may end in the app's report ("Part 1 updated"): it is OK'd first (okLinkReport).
 */
export async function openPart(page: Page, row: ReturnType<Page['locator']>): Promise<FrameLocator> {
  for (let i = 0; ; i++) {
    await okLinkReport(page);
    try {
      await row.locator('> .tree-row').click({ timeout: 5_000 });
      break;
    } catch (e) {
      if (i >= 6 || !(await page.locator('#modal-confirm').isVisible())) throw e;
    }
  }
  const frame = await partOpened(page);
  await okLinkReport(page);
  return frame;
}

/**
 * L3: the app's report after a linked geometry's update landed ("Part 1 updated", "Part 1 v2
 * added"), when it shows: OK. Returns its title, or null when none shows. Any other dialog is
 * left for the caller.
 */
export async function okLinkReport(page: Page): Promise<string | null> {
  const modal = page.locator('#modal-confirm');
  if (!(await modal.isVisible())) return null;
  const title = (await page.locator('#cf-heading').textContent()) ?? '';
  if (!/ (updated|added)$/.test(title)) return null;
  await page.locator('#cf-confirm').click();
  await expect(modal).toBeHidden();
  return title;
}

/**
 * L3 (host API 1.6): an exit with a save still on its way waits for it (the Part's exit hook
 * saves first): the app's header says so over the covered Part, and nothing asks.
 */
export async function expectLeaveWaitsForSave(page: Page, partTitle = 'Part 1'): Promise<void> {
  await expect(page.locator('[data-ws-leave-status]')).toHaveText(`Saving ${partTitle}`, { timeout: 10_000 });
  await expect(page.locator('[data-ws-leave-cover]')).toBeVisible();
  await expect(page.locator('#modal-confirm')).toBeHidden();
}

/** The header's Cancel during an exit: the leave ends, the Part stays open. */
export async function cancelLeave(page: Page): Promise<void> {
  await page.locator('[data-ws-leave-cancel]').click();
  await expect(page.locator('[data-ws-leave-status]')).toHaveCount(0);
  await expect(page.locator('#workspace-overlay')).toBeVisible();
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

// ---- SD pass (decision 2026-10-01): solids come only from sketches (and STEP)

/** A sketch with one closed profile: a rectangle on Top, or a circle on Top (axis Z) or on the Right plane (axis X). */
export interface ProfileSpec {
  /** Rectangle: its corner (x, y) on Top. Circle on Top: its centre (x, y); on the Right plane: its centre (y, z). Default the origin. */
  at?: [number, number];
  /** Rectangle: [W, D] (default 20 x 20). Circle: its diameter (default 20). */
  size?: number[];
  circle?: boolean;
  /** The plane: 'top' (default) or, for a circle, 'right' (a cylinder along X). */
  plane?: 'top' | 'right';
}

/** What a solid made from a sketch is: a block (rectangle) or a cylinder (circle). */
export interface SolidSpec {
  /** A block's corner (x, y, z), or a cylinder's base centre. Default the origin. */
  at?: [number, number, number];
  /** A block's [W, D, H] (default 20 mm each), or a cylinder's [diameter, height]. */
  size?: number[];
  /** A circle (a cylinder) instead of a rectangle. */
  circle?: boolean;
  /** A cylinder along X (a circle on the Right plane, extruded from x = at[0]) instead of Z. */
  axis?: 'x' | 'z';
  op?: 'new' | 'join' | 'cut' | 'intersect';
  scope?: string[];
}

export interface MadeSolid {
  sketch: string;
  extrude: string;
  /** The extrude's body (op new), else null. */
  body: string | null;
}

type CadDocApi = {
  beginNew(t: string, init?: unknown): { feature: string; commit(): void };
  state: { get(): { doc: { features: { id: string; creates?: string | null }[] }; rebuild: { status: string; features: Record<string, { state: string } | undefined>; bodies: { id: string }[]; outputs: Record<string, { type: string; regions?: { key: string; entities: string[]; sample: [number, number] }[] }> } } };
};

/**
 * Sketch N with one closed profile, fully defined by its relations and
 * dimensions (no "(-)" in the tree), set up through the document (the sketch
 * tools themselves are the P3 specs'), once its profile is built. Returns its
 * id. One undo step.
 */
export async function addSketch(page: Page, spec: ProfileSpec = {}): Promise<string> {
  return workspaceFrame(page).evaluate(async (s: ProfileSpec) => {
    const doc = (window as unknown as { __CAD__: { services: { doc: CadDocApi } } }).__CAD__.services.doc;
    const [x, y] = s.at ?? [0, 0];
    const dim = (refs: string[], kind: string, v: number, id: string) => ({ id, kind, refs, expr: `${v} mm`, driving: true });
    const pos = (pt: string, c: string, v: [number, number]) => (v[0] === 0 && v[1] === 0 ? [{ id: c, kind: 'coincident', refs: [pt, 'origin'] }] : [dim(['origin', pt], 'distance_x', v[0], `${c}x`), dim(['origin', pt], 'distance_y', v[1], `${c}y`)]);
    const values = (cs: { id: string; expr?: string }[]) => Object.fromEntries(cs.filter((c) => c.expr).map((c) => [c.id, Number(String(c.expr).replace(' mm', ''))]));
    const frames = {
      top: { plane: 'origin:top', frame: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] } },
      right: { plane: 'origin:right', frame: { origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] } },
    };
    const pl = frames[s.plane ?? 'top'];
    let init: Record<string, unknown>;
    if (s.circle) {
      const dia = s.size?.[0] ?? 20;
      const cs = [...pos('pt_1', 'c_p', [x, y]), dim(['e_1'], 'diameter', dia, 'c_d')];
      init = { points: { pt_1: [x, y] }, entities: [{ id: 'e_1', kind: 'circle', c: 'pt_1', r: dia / 2 }], constraints: cs, solved: { values: values(cs), dof: 0, state: 'fully' } };
    } else {
      const [w, d] = s.size ?? [20, 20];
      const cs = [
        { id: 'c_h1', kind: 'horizontal', refs: ['e_1'] },
        { id: 'c_v2', kind: 'vertical', refs: ['e_2'] },
        { id: 'c_h3', kind: 'horizontal', refs: ['e_3'] },
        { id: 'c_v4', kind: 'vertical', refs: ['e_4'] },
        ...pos('pt_1', 'c_p', [x, y]),
        dim(['e_1'], 'distance', w, 'c_w'),
        dim(['e_2'], 'distance', d, 'c_d'),
      ];
      init = {
        points: { pt_1: [x, y], pt_2: [x + w, y], pt_3: [x + w, y + d], pt_4: [x, y + d] },
        entities: [
          { id: 'e_1', kind: 'line', p: ['pt_1', 'pt_2'] },
          { id: 'e_2', kind: 'line', p: ['pt_2', 'pt_3'] },
          { id: 'e_3', kind: 'line', p: ['pt_3', 'pt_4'] },
          { id: 'e_4', kind: 'line', p: ['pt_4', 'pt_1'] },
        ],
        constraints: cs,
        solved: { values: values(cs), dof: 0, state: 'fully' },
      };
    }
    // A sketch session turns the camera to its plane (sketch mode's Look at), as the user's Sketch
    // does; a sketch set up here as "made earlier" must leave the camera (and whether the view is
    // still the framed one) as it was (SD review round 1: the turn made later clicks and pixels miss).
    const handle = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { lookAt: (...a: unknown[]) => void } | null } } } } }).__CAD__.services.viewport.get().handle;
    const lookAt = handle?.lookAt;
    if (handle) handle.lookAt = () => {};
    let sk: { feature: string; commit(): void };
    try {
      sk = doc.beginNew('sketch', { support: { kind: 'plane', plane: pl.plane }, plane: pl.frame, ...init });
      sk.commit();
    } finally {
      if (handle && lookAt) handle.lookAt = lookAt;
    }
    for (let i = 0; i < 400; i++) {
      const o = doc.state.get().rebuild.outputs[sk.feature];
      if (o && o.type === 'sketch' && o.regions?.length) return sk.feature;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the sketch made no profile');
  }, spec);
}

/**
 * A solid as the app makes it: addSketch (a rectangle, or a circle) then Extrude N
 * of its one profile, through the document. The span [z0, z0 + H] along the
 * sketch normal is a blind extrude when z0 is 0, else Two sides (z0 + H along
 * the normal, -z0 against it). Two undo steps. It returns once the extrude is
 * built (its body drawn) and the view is still: a point projected right after it
 * is where the next click lands (SD review round 1: a click projected before the
 * first body's framing hit an edge).
 */
export async function addSolid(page: Page, spec: SolidSpec = {}): Promise<MadeSolid> {
  const [x, y, z] = spec.at ?? [0, 0, 0];
  const size = spec.size ?? (spec.circle ? [20, 20] : [20, 20, 20]);
  const alongX = spec.circle && spec.axis === 'x';
  const sketch = await addSketch(page, alongX ? { circle: true, plane: 'right', at: [y, z], size: [size[0]] } : { circle: spec.circle, at: [x, y], size: spec.circle ? [size[0]] : [size[0], size[1]] });
  const z0 = alongX ? x : z;
  const h = spec.circle ? size[1] : size[2];
  const made = await workspaceFrame(page).evaluate(
    ({ sketch, z0, h, op, scope }) => {
      const doc = (window as unknown as { __CAD__: { services: { doc: CadDocApi } } }).__CAD__.services.doc;
      const region = doc.state.get().rebuild.outputs[sketch].regions![0];
      const extent = z0 === 0 ? { kind: 'blind', distance: `${h} mm` } : { kind: 'two', distance: `${z0 + h} mm`, distance2: `${-z0} mm` };
      const ex = doc.beginNew('extrude', { profiles: [{ sketch, region: region.key, entities: region.entities, sample: region.sample }], extent, op, ...(op === 'new' ? {} : { creates: null, scope }) });
      ex.commit();
      const made = doc.state.get().doc.features.find((g) => g.id === ex.feature);
      return { sketch, extrude: ex.feature, body: made?.creates ?? null };
    },
    { sketch, z0, h, op: spec.op ?? 'new', scope: spec.scope ?? [] },
  );
  // Built (the rebuild done with the extrude in it), then a still view (the first body is framed).
  await expect
    .poll(
      () =>
        workspaceFrame(page).evaluate((id) => {
          const r = (window as unknown as { __CAD__: { services: { doc: CadDocApi } } }).__CAD__.services.doc.state.get().rebuild;
          return r.status === 'done' && !!r.features[id];
        }, made.extrude),
      { timeout: 60_000 },
    )
    .toBe(true);
  await viewAndSketchIdle(page);
  return made;
}

/** Page coordinates of a model point (the viewport's own projection plus the frame's offset). */
export async function modelOnPage(page: Page, p: [number, number, number]): Promise<[number, number]> {
  const xy = await workspaceFrame(page).evaluate((q) => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { project(p: number[]): [number, number] | null } } } } } }).__CAD__.services.viewport.get().handle.project(q), p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + xy![0], box.y + xy![1]];
}

/** No view transition runs, and sketch mode has stored every edit. */
async function viewAndSketchIdle(page: Page) {
  const f = workspaceFrame(page);
  await expect.poll(() => f.evaluate(() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } | null } } } } }).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
  await f.evaluate(async () => {
    await (window as unknown as { __CAD__: { services: { apis: { get(): { sketch?: { idle?(): Promise<void> } | null } } } } }).__CAD__.services.apis.get().sketch?.idle?.();
  });
}

/**
 * A W x D rectangle from the origin, drawn as a user draws it: the Top plane,
 * Sketch, R, a click on the origin, W Tab D Enter, Finish sketch. It ends in
 * model mode (the sketch fully defined: the typed sizes are its dimensions).
 */
export async function drawRectangle(page: Page, frame: FrameLocator, w: number, d: number): Promise<void> {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await viewAndSketchIdle(page);
  await page.keyboard.press('r');
  await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.rectangle"]')).toHaveClass(/is-active/);
  const o = await modelOnPage(page, [0, 0, 0]);
  await page.mouse.click(o[0], o[1]);
  const c = await modelOnPage(page, [w * 0.8, d * 0.7, 0]);
  await page.mouse.move(c[0], c[1]);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type(String(w));
  await page.keyboard.press('Tab');
  await page.keyboard.type(String(d));
  await page.keyboard.press('Enter');
  await viewAndSketchIdle(page);
  await page.keyboard.press('Escape');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

/**
 * A W x D x H block drawn as a user draws it: drawRectangle, then Extrude with H
 * typed and Done. It ends in model mode with the panel closed.
 */
export async function drawBlock(page: Page, frame: FrameLocator, w: number, d: number, h: number): Promise<void> {
  await drawRectangle(page, frame, w, d);
  await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-profile-list] [data-profile]')).toHaveCount(1);
  const dist = panel.locator('.nui[data-field="distance"] input');
  await dist.fill(String(h));
  await dist.press('Enter');
  await expect(panel.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveCount(0);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
}

/** History labels as the tree shows them, in order. */
export const historyNames = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl');

// ---- LINK (host API 1.5): the Part's design as a project geometry

/** What the link controller answered (src/link/controller.ts LinkOutcome), JSON-safe. */
export interface LinkOutcomeJson {
  outcome: 'unchanged' | 'linked' | 'kept-editing' | 'superseded' | 'nothing' | 'failed' | 'unavailable';
  code?: string;
  message?: string;
  sourceVersion?: number;
  geometryId?: string;
  result?: { geometryId: string; name: string; rev: number; fromRev: number | null; created: boolean; change: string; bodies: number; faces: number; named: number };
}

type LinkWindow = {
  __CAD__: {
    link: { sync(o?: { notify?: boolean }): Promise<unknown> };
    services: {
      bridge: { link: { linkedGeometry(): Promise<unknown> }; files: { read(rel: string): Promise<ArrayBuffer | null>; write: (...a: unknown[]) => Promise<unknown> } };
      doc: { state: { get(): { sourceVersion: number; save: { state: string } } } };
    };
  };
};

/**
 * Bring the project's geometry up to date with the open Part, as leaving the
 * workspace will (host API 1.6): the link controller, reached by tests only (the
 * Part has no button for it). Resolves with its outcome; while the app's question
 * is open it stays pending, so start it, answer, then await it.
 */
export function syncLink(page: Page): Promise<LinkOutcomeJson> {
  return workspaceFrame(page).evaluate(async () => JSON.parse(JSON.stringify(await (window as unknown as LinkWindow).__CAD__.link.sync())) as LinkOutcomeJson);
}

/** The geometry the Part links now (ws.project.linkedGeometry()), or null. */
export async function linkedGeometry(page: Page): Promise<{ geometryId: string; name: string; rev: number; sourceVersion: number; shapeSha256: string; namesSha256: string | null } | null> {
  return workspaceFrame(page).evaluate(async () => JSON.parse(JSON.stringify(await (window as unknown as LinkWindow).__CAD__.services.bridge.link.linkedGeometry())));
}

/** The Part's saved design version (the model file's save counter). */
export async function sourceVersion(page: Page): Promise<number> {
  return workspaceFrame(page).evaluate(() => (window as unknown as LinkWindow).__CAD__.services.doc.state.get().sourceVersion);
}

/** A file of the plugin's folder in this project, read through the Part's own ws.files (base64), or null. */
export async function pluginFile(page: Page, rel: string): Promise<Buffer | null> {
  const b64 = await workspaceFrame(page).evaluate(async (r) => {
    const buf = await (window as unknown as LinkWindow).__CAD__.services.bridge.files.read(r);
    if (!buf) return null;
    let s = '';
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  }, rel);
  return b64 == null ? null : Buffer.from(b64, 'base64');
}

/** Count the Part's ws.files writes from now on (window.__linkWrites in the frame). */
export async function countFileWrites(page: Page): Promise<void> {
  await workspaceFrame(page).evaluate(() => {
    const w = window as unknown as LinkWindow & { __linkWrites?: string[] };
    const files = w.__CAD__.services.bridge.files;
    w.__linkWrites = [];
    const write = files.write.bind(files);
    files.write = (...a: unknown[]) => {
      w.__linkWrites!.push(String(a[0]));
      return write(...a);
    };
  });
}

export async function fileWrites(page: Page): Promise<string[]> {
  return workspaceFrame(page).evaluate(() => [...((window as unknown as { __linkWrites?: string[] }).__linkWrites ?? [])]);
}

/** The app's question over the workspace when the shape changed under simulation setup (#modal-link-choice). */
export async function readLinkQuestion(page: Page): Promise<{ title: string; copy: string; overwrite: string; overwriteDisabled: boolean; overwriteLine: string; newLabel: string; cancel: string }> {
  const modal = page.locator('#modal-link-choice');
  await expect(modal).toBeVisible({ timeout: 120_000 });
  return {
    title: (await page.locator('#lc-heading').textContent()) ?? '',
    copy: (await page.locator('#lc-copy').textContent()) ?? '',
    overwrite: (await page.locator('#lc-overwrite').textContent()) ?? '',
    overwriteDisabled: await page.locator('#lc-overwrite').isDisabled(),
    overwriteLine: (await page.locator('#lc-overwrite-line').textContent()) ?? '',
    newLabel: (await page.locator('#lc-new').textContent()) ?? '',
    cancel: (await page.locator('#lc-cancel').textContent()) ?? '',
  };
}

/** Answer the app's question: 'new' (Save as new geometry), 'overwrite' or 'cancel' (Keep editing). */
export async function answerLinkQuestion(page: Page, choice: 'new' | 'overwrite' | 'cancel'): Promise<void> {
  await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
  await page.locator({ new: '#lc-new', overwrite: '#lc-overwrite', cancel: '#lc-cancel' }[choice]).click();
  await expect(page.locator('#modal-link-choice')).toBeHidden();
}

/** A project geometry's row in the workbench tree (after Back). */
export const geometryRow = (page: Page, gid: string) => page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);

/** A simulation study on a geometry (the route the workbench uses): {id, name}. */
export async function simulationOn(request: APIRequestContext, projectId: string, geometryId: string, base = baseUrl()): Promise<{ id: string; name: string }> {
  const r = await request.post(`${base}/api/simulation`, { data: { project_id: projectId, geometry_id: geometryId } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return { id: j.simulation.id, name: j.simulation.name };
}

/** A Wall boundary condition on some faces of a geometry's rev (setup the app's question protects). */
export async function wallOn(request: APIRequestContext, projectId: string, simId: string, faces: string[], rev: number, base = baseUrl()): Promise<string> {
  const r = await request.post(`${base}/api/bcs`, { data: { project_id: projectId, simulation_id: simId, name: 'Side wall', bc_type: 'Wall', faces, geometry_rev: rev } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return j.bc.id;
}
