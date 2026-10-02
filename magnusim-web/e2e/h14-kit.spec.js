import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startHost } from './support/host-server.mjs';

// H14, the plugin UI kit (src/plugin-ui/) as plugins and users meet it.
// - gate:h14-kit-parity: every kit specimen on the dev sheet (#/dev/ui-kit) looks the
//   same in the page and in a sandboxed workspace frame that runs the shipped
//   /plugin-sdk/plugin-ui.js, at rest, hovered and focused, and every kit control
//   matches the core control it copies. The exception lists are empty.
// - gate:h14-field-widget-kit: a plugin's field widget built on the kit draws, saves,
//   cancels and survives a reload in the Mesh panel, and a widget whose plugin UI loads
//   after the panel opened replaces the core input with nothing else rebuilding the form.
// - gate:h14-workspace-kit: kit controls in a plugin workspace frame; its toasts stay in
//   the workspace, one at a time; app toasts draw above the workspace; the switch takes Space.
// - gate:h14-no-kit-in-core: the core draws no kit markup, and the dev sheet is not served
//   by a server started without VITE_MAGNUSIM_DEV_SHEETS=1.
// - gate:h14-app-toast-stack: a pointer held still on one app toast keeps every app toast
//   up, so none closes and slides another out from under it.
// The first three share one second server (startHost) with the kit-demo test plugin
// (python/tests/fixtures/kit-plugins) and the dev sheet turned on for that server only.
// MAGNUSIM_KIT_SHOTS=<folder> also saves the sign-off screenshots (h14-*.png) there.
const PROJECT = 'sample-project-steady-state-e2e';
const KEY = 'kit-demo';
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHEET_FRAME = 'iframe[title="UI kit in a workspace frame"]';

function stage(t0, msg) {
  console.log(`[h14 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

// ---------------------------------------------------------------------------
// What the parity gate compares. These run inside the page or the frame.

/**
 * For each named specimen, every element under its box in DOM order: its computed
 * style, its drawn ::before/::after and its box. Runs in the page or the frame
 * (self-contained: Playwright sends only this function's text).
 */
function readSpecimens(names) {
  const all = (cs) => {
    const o = {};
    for (let i = 0; i < cs.length; i++) o[cs[i]] = cs.getPropertyValue(cs[i]);
    return o;
  };
  const readSubtree = (sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    return [...root.querySelectorAll('*')].map((el) => {
      const r = el.getBoundingClientRect();
      const pseudo = {};
      for (const which of ['::before', '::after']) {
        const ps = getComputedStyle(el, which);
        const content = ps.getPropertyValue('content');
        // Chrome answers for pseudo-elements that are not drawn; only drawn ones count.
        pseudo[which] = content !== 'none' && content !== 'normal' ? all(ps) : { content };
      }
      const cls = (el.getAttribute('class') || '').trim();
      return {
        el: el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/).join('.') : ''),
        style: all(getComputedStyle(el)),
        pseudo,
        box: [r.width, r.height],
      };
    });
  };
  const out = {};
  for (const n of names) out[n] = readSubtree(`[data-kit-specimen="${n}"]`);
  return out;
}

/** readSpecimens in the page or the frame. */
async function readMany(target, names) {
  return target.evaluate(readSpecimens, names);
}

const drawn = (p) => Object.keys(p).length > 1;

// Box sizes are compared to 0.01 px. SVG geometry is computed in floats from the
// element's place on the screen, and the page and the frame put a specimen at
// different offsets, so an icon or a plot line can differ by about 1e-4 px. CSS lays
// boxes out in 1/64 px steps, so any real difference is larger than this.
const BOX_EPS = 0.01;
const sameSize = (a, b) => Math.abs(a - b) <= BOX_EPS;

/** Every difference between the page's and the frame's reading of one specimen. */
function diffSubtree(name, page, frame) {
  if (!page || !frame) return [`${name}: missing in the ${page ? 'frame' : 'page'}`];
  const out = [];
  if (page.length !== frame.length) out.push(`${name}: ${page.length} elements in the page, ${frame.length} in the frame`);
  for (let i = 0; i < Math.min(page.length, frame.length); i++) {
    const a = page[i];
    const b = frame[i];
    const where = `${name} #${i} ${a.el}`;
    if (a.el !== b.el) {
      out.push(`${where}: the frame has ${b.el} here`);
      continue;
    }
    for (const k of new Set([...Object.keys(a.style), ...Object.keys(b.style)])) {
      if (a.style[k] !== b.style[k]) out.push(`${where} ${k}: page ${a.style[k]} | frame ${b.style[k]}`);
    }
    for (const which of ['::before', '::after']) {
      const pa = a.pseudo[which];
      const pb = b.pseudo[which];
      if (!drawn(pa) && !drawn(pb)) continue;
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        if (pa[k] !== pb[k]) out.push(`${where}${which} ${k}: page ${pa[k]} | frame ${pb[k]}`);
      }
    }
    if (!sameSize(a.box[0], b.box[0]) || !sameSize(a.box[1], b.box[1])) out.push(`${where} box: page ${a.box.join('x')} | frame ${b.box.join('x')}`);
  }
  return out;
}

// Kit vs core: the properties a kit part must share with the core part it copies.
const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const PAIR_PROPS = [
  'display',
  'box-sizing',
  ...SIDES.map((s) => `margin-${s}`),
  ...SIDES.map((s) => `padding-${s}`),
  ...SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  ...CORNERS.map((c) => `border-${c}-radius`),
  'background-color',
  'background-image',
  'box-shadow',
  'opacity',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration-line',
  'text-transform',
  'white-space',
  'gap',
  'align-items',
  'justify-content',
  'flex-direction',
  'list-style-type',
  'fill',
  'stroke',
  'stroke-width',
];
const BEFORE_PROPS = ['width', 'height', 'left', 'top', 'background-color', 'border-radius', 'transform'];
// PanelChrome/card: the card itself, not the layout around it.
const CARD_PROPS = [
  'background-color',
  'background-image',
  ...SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  ...CORNERS.map((c) => `border-${c}-radius`),
  'box-shadow',
  ...SIDES.map((s) => `padding-${s}`),
];

/**
 * The [data-kit-part] elements under `sel`, by name: the given properties, the box
 * (unless `noBox`), ::before when marked, and polyline points.
 */
function readParts({ sel, props, beforeProps, noBox }) {
  const box = document.querySelector(sel);
  if (!box) return null;
  const parts = {};
  const twice = [];
  for (const el of box.querySelectorAll('[data-kit-part]')) {
    const name = el.getAttribute('data-kit-part');
    if (parts[name]) twice.push(name);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const style = {};
    for (const p of props) style[p] = cs.getPropertyValue(p);
    if (!noBox) {
      style['box width'] = r.width;
      style['box height'] = r.height;
    }
    const part = { tag: el.tagName.toLowerCase(), style };
    if (el.getAttribute('data-kit-pseudo') === 'before') {
      const b = getComputedStyle(el, '::before');
      part.before = {};
      for (const p of beforeProps) part.before[p] = b.getPropertyValue(p);
    }
    if (part.tag === 'polyline') part.points = el.getAttribute('points');
    parts[name] = part;
  }
  return { parts, twice };
}

/** The full list of kit-vs-core pairs on the sheet and the parts each compares. */
const PAIRS = {
  'Button/primary': ['root'],
  'Button/primary-disabled': ['root'],
  'Button/secondary': ['root'],
  'Button/secondary-disabled': ['root'],
  'Button/neutral': ['root'],
  'Button/link': ['root'],
  'DisabledReason/reason': ['root', 'msg'],
  'DisabledReason/reason-fix': ['root', 'msg', 'fix'],
  'Hint/muted': ['root'],
  'EmptyState/list': ['root'],
  'EmptyState/chart': ['root'],
  'NumberUnitInput/narrow-length': ['root', 'input', 'unit'],
  'NumberUnitInput/wide': ['root', 'input', 'unit'],
  'NumberUnitInput/fill': ['root', 'input'],
  'Select/default': ['root', 'option'],
  'Toggle/switch-off': ['root', 'input', 'track'],
  'Toggle/switch-on': ['root', 'input', 'track'],
  'Toggle/pill-off': ['root'],
  'Toggle/pill-on': ['root'],
  'Field/plain': ['root', 'k', 'label', 'v'],
  'Field/help': ['root', 'k', 'label', 'help', 'tip'],
  'PanelChrome/flyout': ['head', 'title', 'body', 'foot', 'foot-left', 'delete', 'done'],
  'PanelChrome/card': ['root'],
  'StatusBlock/running': ['root', 'title', 'line', 'elapsed'],
  'StatusBlock/done': ['root', 'title', 'line', 'meta'],
  'StatusBlock/eta': ['root', 'eta'],
  'Toast/info': ['root', 'msg', 'close'],
  'Toast/success': ['root', 'msg', 'close'],
  'Toast/error': ['root', 'msg', 'close'],
  'LinePlot/log-iterations': ['wrap', 'svg', 'legend', 'swatch', 'line', 'tip'],
};
// Toggle's track is compared with its ::before (the knob) too.
const PAIR_BEFORE = { 'Toggle/switch-off': ['track'], 'Toggle/switch-on': ['track'] };

/** Every difference between a pair's core and kit parts. */
function diffPair(pair, core, kit) {
  const want = PAIRS[pair];
  if (!core || !kit) return [`${pair}: no ${core ? 'kit' : 'core'} box`];
  const out = [];
  for (const [side, r] of [
    ['core', core],
    ['kit', kit],
  ]) {
    if (r.twice.length) out.push(`${pair}: the ${side} box marks ${r.twice.join(', ')} twice`);
    const names = Object.keys(r.parts).sort();
    if (JSON.stringify(names) !== JSON.stringify([...want].sort())) out.push(`${pair}: ${side} parts ${names.join(',')}, want ${[...want].sort().join(',')}`);
  }
  for (const name of want) {
    const a = core.parts[name];
    const b = kit.parts[name];
    if (!a || !b) continue;
    const where = `${pair} ${name}`;
    // The plot's line is compared by its stroke and its points only.
    const keys = pair.startsWith('LinePlot/') && name === 'line' ? ['stroke', 'stroke-width'] : Object.keys(a.style);
    for (const k of keys) {
      const same = k.startsWith('box ') ? sameSize(a.style[k], b.style[k]) : a.style[k] === b.style[k];
      if (!same) out.push(`${where} ${k}: core ${a.style[k]} | kit ${b.style[k]}`);
    }
    if (a.points !== b.points) out.push(`${where} points: core ${a.points} | kit ${b.points}`);
    if ((PAIR_BEFORE[pair] || []).includes(name)) {
      if (!a.before || !b.before) out.push(`${where}::before: not marked on the ${a.before ? 'kit' : 'core'} side`);
      else for (const k of BEFORE_PROPS) if (a.before[k] !== b.before[k]) out.push(`${where}::before ${k}: core ${a.before[k]} | kit ${b.before[k]}`);
    }
  }
  if (pair === 'LinePlot/log-iterations') {
    if (core.parts.swatch?.tag !== 'i' || kit.parts.swatch?.tag !== 'i') out.push(`${pair} swatch: core <${core.parts.swatch?.tag}>, kit <${kit.parts.swatch?.tag}>, want <i> on both`);
    for (const [side, r] of [
      ['core', core],
      ['kit', kit],
    ]) {
      if (r.parts.svg && r.parts.svg.style['box height'] !== 132) out.push(`${pair} svg: ${side} box height ${r.parts.svg.style['box height']}, want 132`);
    }
  }
  return out;
}

// PanelChrome/card compares the card's own look only: the core card is the flyout's
// .mat-panel, sized by the flyout, and the kit card fills its box.
const PAIR_PROPS_FOR = (pair) => (pair === 'PanelChrome/card' ? CARD_PROPS : PAIR_PROPS);
const pairArgs = (pair, sel) => ({ sel, props: PAIR_PROPS_FOR(pair), beforeProps: BEFORE_PROPS, noBox: pair === 'PanelChrome/card' });

async function readPair(page, pair) {
  const [core, kit] = await Promise.all([
    page.evaluate(readParts, pairArgs(pair, `[data-kit-core-pair="${pair}"]`)),
    page.evaluate(readParts, pairArgs(pair, `[data-kit-core-kit="${pair}"]`)),
  ]);
  return { core, kit };
}

/** The required specimens; the sheet may show more, and every one it shows is compared. */
const REQUIRED_SPECIMENS = [
  ...['primary', 'primary-disabled', 'primary-block', 'secondary', 'secondary-disabled', 'neutral', 'link', 'fix', 'danger', 'danger-disabled'].map(
    (s) => `Button/${s}`,
  ),
  ...['narrow-length', 'wide', 'fill', 'no-unit', 'disabled'].map((s) => `NumberUnitInput/${s}`),
  'Select/default',
  'Select/disabled',
  ...['switch-off', 'switch-on', 'switch-disabled', 'pill-off', 'pill-on'].map((s) => `Toggle/${s}`),
  'Field/plain',
  'Field/help',
  'Hint/muted',
  'Hint/warning',
  'Hint/danger',
  'DisabledReason/reason',
  'DisabledReason/reason-fix',
  'EmptyState/list',
  'EmptyState/chart',
  ...['pencil', 'trash', 'back', 'document', 'path'].map((s) => `Icon/${s}`),
  ...['plain', 'delete', 'card', 'foot-extra'].map((s) => `PanelChrome/${s}`),
  'StatusBlock/running',
  'StatusBlock/done',
  'StatusBlock/eta',
  'Elapsed/fixed',
  'Toast/info',
  'Toast/success',
  'Toast/error',
  'PanelError/card',
  'PanelError/with-done',
  'LinePlot/log-iterations',
  'LinePlot/log-seconds',
  'LinePlot/linear',
  'ColorLegend/rainbow',
  'ColorLegend/viridis',
  'ColorLegend/balance-centred',
  'ColorLegend/curl',
  ...['formatSimTime', 'formatElapsed', 'formatEta', 'formatSci', 'parseSci'].map((s) => `Formatters/${s}`),
  ...['fieldUnit', 'fieldQuantity', 'toSi', 'fromSi', 'convertQuantity', 'preferredUnit', 'resolveUnit', 'unitLabels', 'siUnitLabel', 'UNITS', 'IMPERIAL_DEFAULT', 'SI_DEFAULT'].map(
    (s) => `Units/${s}`,
  ),
  'Constants/PLUGIN_UI_API_VERSION',
];
const ENABLED_BUTTONS = ['primary', 'primary-block', 'secondary', 'neutral', 'link', 'fix', 'danger'].map((s) => `Button/${s}`);
const CHROME = ['plain', 'delete', 'card', 'foot-extra'].map((s) => `PanelChrome/${s}`);
const REQUIRED_HOVER = [
  ...ENABLED_BUTTONS,
  'Toggle/pill-off',
  'Toggle/pill-on',
  'Field/help',
  'DisabledReason/reason-fix',
  ...CHROME,
  'LinePlot/log-iterations',
  'LinePlot/log-seconds',
  'LinePlot/linear',
];
const REQUIRED_FOCUS = [
  ...ENABLED_BUTTONS,
  'NumberUnitInput/narrow-length',
  'Select/default',
  'Toggle/switch-off',
  'Toggle/pill-off',
  'Field/help',
  'DisabledReason/reason-fix',
  ...CHROME,
  'Toast/info',
  'Toast/success',
  'Toast/error',
];

const specSel = (name) => `[data-kit-specimen="${name}"]`;
const targetSel = (name) => `${specSel(name)} [data-kit-target]`;
const slug = (name) => name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

/** Hover a specimen's target: a plot at 60 % of its width, anything else in its middle. */
async function hoverTarget(side, name) {
  if (name.startsWith('LinePlot/')) {
    const svg = side.locator(`${targetSel(name)} svg`);
    const box = await svg.boundingBox();
    await svg.hover({ position: { x: box.width * 0.6, y: box.height / 2 } });
  } else {
    await side.locator(targetSel(name)).hover();
  }
}

/**
 * Focus `target` inside the box `box` the way a keyboard user does: click a
 * sentinel just outside the box, then Tab until the target has the focus.
 * Returns whether the target matches :focus-visible.
 */
async function focusWithin(page, side, box, target) {
  await side.evaluate((sel) => {
    const el = document.querySelector(sel);
    const s = document.createElement('span');
    s.tabIndex = 0;
    s.setAttribute('data-kit-sentinel', '1');
    // Out of the flow, in the column's padding left of the box: the box's layout does not change.
    s.style.cssText = 'position:absolute;display:block;width:6px;height:6px;margin-left:-7px;';
    el.parentElement.insertBefore(s, el);
  }, box);
  await side.locator('[data-kit-sentinel]').click();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const on = await side.evaluate((sel) => document.activeElement === document.querySelector(sel), target);
    if (on) break;
  }
  return side.evaluate((sel) => {
    const el = document.querySelector(sel);
    return !!el && document.activeElement === el && el.matches(':focus-visible');
  }, target);
}

/** Focus a specimen's target by Tab (see focusWithin). */
function focusTarget(page, side, name) {
  return focusWithin(page, side, specSel(name), targetSel(name));
}

// What a hovered or focused specimen must show, beyond page = frame: the Field help
// tip (page and frame would also be equal if neither showed it).
const SHOWN_WHEN_ACTIVE = { 'Field/help': 'span.mgk-field-tip' };
const shownDisplay = (reading, el) => (reading || []).find((e) => e.el === el)?.style.display;

// Kit vs core, hovered and focused: the pairs whose core part has its own :hover look
// (.js-btn, .mat-clear-link, .sim-fix-go) or shows the help tip (.mat-k-tip), and the part.
const PAIR_ACTIVE = { 'Button/neutral': 'root', 'Button/link': 'root', 'DisabledReason/reason-fix': 'fix', 'Field/help': 'help' };
const FOCUS_PAIR_PROPS = [...PAIR_PROPS, 'outline-style', 'outline-width', 'outline-color', 'outline-offset'];

async function unfocus(side) {
  await side.evaluate(() => {
    document.querySelector('[data-kit-sentinel]')?.remove();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}

test('gate:h14-no-kit-in-core the core draws no kit markup and the dev sheet is not served', async ({ page, request }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  if (process.env.VITE_MAGNUSIM_DEV_SHEETS !== undefined) {
    throw new Error(
      'VITE_MAGNUSIM_DEV_SHEETS is set in this shell, so the default server serves the dev sheet. Unset it (PowerShell: Remove-Item Env:VITE_MAGNUSIM_DEV_SHEETS) and run again.',
    );
  }
  const kitCount = () => page.evaluate(() => document.querySelectorAll('[class^="mgk-"],[class*=" mgk-"]').length);
  const noToastOrPanelError = async () => {
    await expect(page.locator('.app-toasts > *'), 'no app toast showing').toHaveCount(0);
    await expect(page.locator('[data-plugin-toast], [data-ws-toast]'), 'no plugin or workspace toast showing').toHaveCount(0);
  };

  await page.goto('/');
  await expect(page.locator('#home')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => window.__CFD_PLUGINS_READY__ === true, null, { timeout: 60_000 });
  await noToastOrPanelError();
  expect(await kitCount(), 'kit elements on Home').toBe(0);
  stage(t0, 'Home: no kit markup');

  await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Elbow', { timeout: 30_000 });
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  await page.waitForFunction(() => window.__CFD_PLUGINS_READY__ === true, null, { timeout: 60_000 });
  await noToastOrPanelError();
  expect(await kitCount(), 'kit elements in the workbench').toBe(0);
  stage(t0, 'workbench: no kit markup');

  // The sheet's hash, loaded fresh, is just Home on a server without the flag.
  await page.goto('/#/dev/ui-kit');
  await page.reload();
  await expect(page.locator('#home')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(5_000);
  await expect(page.locator('[data-kit-sheet-ready]')).toHaveCount(0);
  for (const file of ['ui-kit-sheet.html', 'ui-kit-sheet.js']) {
    expect((await request.get(`/plugin-sdk/${file}`)).status(), file).toBe(404);
  }
  stage(t0, '#/dev/ui-kit shows Home; the sheet files are 404');
});

test('gate:h14-app-toast-stack a still pointer on one app toast holds the whole stack', async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  await page.goto('/');
  await expect(page.locator('#home')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => window.__CFD_PLUGINS_READY__ === true, null, { timeout: 60_000 });
  const toasts = page.locator('.app-toasts .mgk-toast');
  await expect(toasts).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.__CFD_PLUGIN_UI__.toast('Older toast'));
  await page.evaluate(() => window.__CFD_PLUGIN_UI__.toast('Newer toast'));
  await expect(toasts).toHaveCount(2);
  // Newest last: the older one sits above the newer one, in a column anchored at the bottom.
  const older = toasts.filter({ hasText: 'Older toast' });
  const box = await older.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The pointer stays put. Each would close after 3.8 s on its own; without the stack's
  // hold the newer one closed then, the older one slid down from under the pointer, lost
  // its hover and closed about 3.8 s later.
  await page.waitForTimeout(8_500);
  await expect(toasts).toHaveCount(2);
  expect(await older.boundingBox(), 'the older toast has not moved').toEqual(box);
  stage(t0, 'pointer on the older of two app toasts: both still there after 8.5 s, nothing moved');

  // Leaving starts each one again from its full time.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2_500);
  await expect(toasts).toHaveCount(2);
  await expect(toasts).toHaveCount(0, { timeout: 4_000 });
  stage(t0, 'pointer gone: both still there 2.5 s later, both closed by 6.5 s');
});

test.describe('h14 server', () => {
  let host;
  test.beforeAll(async () => {
    // A hook gets the test timeout: 60 s without WSL (e2e/support/app-config.js),
    // and startHost may wait up to 120 s for the server.
    test.setTimeout(180_000);
    host = await startHost({
      name: 'h14',
      pluginsFrom: 'python/tests/fixtures/kit-plugins',
      env: { VITE_MAGNUSIM_DEV_SHEETS: '1' },
      log: (l) => console.log(l),
    });
  });
  test.afterEach(async ({}, testInfo) => {
    if (host && testInfo.status !== testInfo.expectedStatus) console.log(`[h14] server output (last 3000 characters):\n${host.log().slice(-3000)}`);
  });
  test.afterAll(() => {
    // Two servers on one node_modules share Vite's cache unless given their own (viteCacheDir).
    if (host && /new dependencies optimized/i.test(host.log())) console.log('[h14] the h14 server re-optimized Vite dependencies during the run');
    host?.stop();
  });

  test('gate:h14-kit-parity the kit looks the same in the page and in a frame, and like the core', async ({ page }) => {
    test.setTimeout(600_000);
    page.setDefaultTimeout(30_000);
    const t0 = Date.now();
    // Wide enough for the four columns, so nothing is hovered through a scroll.
    await page.setViewportSize({ width: 1500, height: 900 });

    // 1. Open the sheet, in the page and in its frame.
    await page.goto(`${host.base}/#/dev/ui-kit`);
    await expect(page.locator('[data-kit-sheet-ready="page"]')).toHaveCount(1, { timeout: 60_000 });
    let frame;
    await expect
      .poll(() => {
        frame = page.frames().find((f) => f.url().includes('/plugin-sdk/ui-kit-sheet.html'));
        return !!frame;
      }, { timeout: 30_000 })
      .toBe(true);
    await expect(frame.locator('[data-kit-sheet-ready="frame"]')).toHaveCount(1, { timeout: 60_000 });
    stage(t0, 'sheet ready in the page and the frame');

    // 2. The frame runs the shipped kit files; the page runs the app's own copy.
    const resources = (target) => target.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
    const inFrame = await resources(frame);
    expect(inFrame).toContain('/plugin-sdk/plugin-ui.js');
    expect(inFrame).toContain('/plugin-sdk/plugin-ui.css');
    const inPage = await resources(page);
    expect(inPage).not.toContain('/plugin-sdk/plugin-ui.js');
    expect(inPage).not.toContain('/plugin-sdk/plugin-ui.css');
    stage(t0, `frame loaded /plugin-sdk/plugin-ui.js and .css; the page neither`);

    // 3. Page vs frame, every specimen, at rest. No exceptions.
    const names = (target, attr) => target.evaluate((a) => [...document.querySelectorAll(`[${a}]`)].map((e) => e.getAttribute('data-kit-specimen')), attr);
    const pageNames = await names(page, 'data-kit-specimen');
    const frameNames = await names(frame, 'data-kit-specimen');
    expect(frameNames).toEqual(pageNames);
    expect(new Set(pageNames).size, 'specimen names are unique').toBe(pageNames.length);
    for (const n of REQUIRED_SPECIMENS) expect(pageNames, `required specimen ${n}`).toContain(n);
    const hoverNames = await names(page, 'data-kit-hover');
    const focusNames = await names(page, 'data-kit-focus');
    expect(await names(frame, 'data-kit-hover')).toEqual(hoverNames);
    expect(await names(frame, 'data-kit-focus')).toEqual(focusNames);
    for (const n of REQUIRED_HOVER) expect(hoverNames, `hover on ${n}`).toContain(n);
    for (const n of REQUIRED_FOCUS) expect(focusNames, `focus on ${n}`).toContain(n);

    const compareAtRest = async (list) => {
      const [p, f] = await Promise.all([readMany(page, list), readMany(frame, list)]);
      return list.flatMap((n) => diffSubtree(n, p[n], f[n]));
    };
    const atRest = await compareAtRest(pageNames);
    expect(atRest, atRest.slice(0, 60).join('\n')).toEqual([]);
    stage(t0, `${pageNames.length} specimens equal in page and frame at rest`);

    // 4. Hovered and focused (focus reached by Tab, so :focus-visible holds on both sides).
    const shots = process.env.MAGNUSIM_KIT_SHOTS || '';
    if (shots) mkdirSync(shots, { recursive: true });
    const shotPath = (side, name, what) => join(shots, `h14-${side}-${slug(name)}${what ? '-' + what : ''}.png`);
    const shoot = async (side, name, what) => {
      if (!shots) return;
      const target = side === 'page' ? page : page.frameLocator(SHEET_FRAME);
      await target.locator(specSel(name)).screenshot({ path: shotPath(side, name, what) });
    };
    // A hovered or focused specimen as it is on screen now: its box and whatever draws
    // outside it (a help tip), without scrolling, so the hover stays.
    const shootLive = async (side, name, what) => {
      if (!shots) return;
      const r = await (side === 'page' ? page : frame).evaluate((n) => {
        const box = document.querySelector(`[data-kit-specimen="${n}"]`);
        let { left, top, right, bottom } = box.getBoundingClientRect();
        for (const el of box.querySelectorAll('*')) {
          const e = el.getBoundingClientRect();
          if (!e.width || !e.height) continue;
          left = Math.min(left, e.left);
          top = Math.min(top, e.top);
          right = Math.max(right, e.right);
          bottom = Math.max(bottom, e.bottom);
        }
        return { left, top, right, bottom };
      }, name);
      const off = side === 'page' ? { x: 0, y: 0 } : await page.locator(SHEET_FRAME).boundingBox();
      const vp = page.viewportSize();
      const x = Math.max(0, Math.floor(r.left + off.x));
      const y = Math.max(0, Math.floor(r.top + off.y));
      const width = Math.min(vp.width, Math.ceil(r.right + off.x)) - x;
      const height = Math.min(vp.height, Math.ceil(r.bottom + off.y)) - y;
      if (width > 0 && height > 0) await page.screenshot({ path: shotPath(side, name, what), clip: { x, y, width, height } });
    };
    const settle = () => page.waitForTimeout(200);
    for (const n of hoverNames) {
      await hoverTarget(page, n);
      await settle();
      const p = (await readMany(page, [n]))[n];
      await shootLive('page', n, 'hover');
      await hoverTarget(frame, n);
      await settle();
      const f = (await readMany(frame, [n]))[n];
      await shootLive('frame', n, 'hover');
      const d = diffSubtree(`${n} (hover)`, p, f);
      expect(d, d.slice(0, 40).join('\n')).toEqual([]);
      if (SHOWN_WHEN_ACTIVE[n]) {
        expect(shownDisplay(p, SHOWN_WHEN_ACTIVE[n]), `${n} hovered shows ${SHOWN_WHEN_ACTIVE[n]} in the page`).toBe('block');
        expect(shownDisplay(f, SHOWN_WHEN_ACTIVE[n]), `${n} hovered shows ${SHOWN_WHEN_ACTIVE[n]} in the frame`).toBe('block');
      }
    }
    await page.mouse.move(0, 0);
    stage(t0, `${hoverNames.length} specimens equal hovered (the Field help tip shown on both sides)`);
    for (const n of focusNames) {
      expect(await focusTarget(page, page, n), `${n}: page target is :focus-visible`).toBe(true);
      await settle();
      const p = (await readMany(page, [n]))[n];
      await shootLive('page', n, 'focus');
      await unfocus(page);
      expect(await focusTarget(page, frame, n), `${n}: frame target is :focus-visible`).toBe(true);
      await settle();
      const f = (await readMany(frame, [n]))[n];
      await shootLive('frame', n, 'focus');
      await unfocus(frame);
      const d = diffSubtree(`${n} (focus)`, p, f);
      expect(d, d.slice(0, 40).join('\n')).toEqual([]);
      if (SHOWN_WHEN_ACTIVE[n]) {
        expect(shownDisplay(p, SHOWN_WHEN_ACTIVE[n]), `${n} focused shows ${SHOWN_WHEN_ACTIVE[n]} in the page`).toBe('block');
        expect(shownDisplay(f, SHOWN_WHEN_ACTIVE[n]), `${n} focused shows ${SHOWN_WHEN_ACTIVE[n]} in the frame`).toBe('block');
      }
    }
    // At rest the tip is hidden on both sides.
    await page.mouse.move(0, 0);
    for (const [n, el] of Object.entries(SHOWN_WHEN_ACTIVE)) {
      const [p, f] = await Promise.all([readMany(page, [n]), readMany(frame, [n])]);
      expect(shownDisplay(p[n], el), `${n} at rest hides ${el} in the page`).toBe('none');
      expect(shownDisplay(f[n], el), `${n} at rest hides ${el} in the frame`).toBe('none');
    }
    stage(t0, `${focusNames.length} specimens equal focused (the Field help tip shown on both sides)`);

    // 5. Every token has the same value in the page and the frame.
    const tokenNames = [...readFileSync(join(WEB, 'src', 'theme', 'tokens.css'), 'utf8').matchAll(/^\s*(--mg-[\w-]+)\s*:/gm)].map((m) => m[1]);
    expect(tokenNames.length).toBeGreaterThan(40);
    const tokens = (target) =>
      target.evaluate((list) => Object.fromEntries(list.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()])), tokenNames);
    const pageTokens = await tokens(page);
    for (const n of tokenNames) expect(pageTokens[n], `${n} is defined in the page`).not.toBe('');
    expect(await tokens(frame)).toEqual(pageTokens);
    stage(t0, `${tokenNames.length} tokens equal`);

    // 6. Kit vs core (page only), over the fixed property set. No allowed differences.
    const pairNames = await page.evaluate(() => [...document.querySelectorAll('[data-kit-core-pair]')].map((e) => e.getAttribute('data-kit-core-pair')));
    const kitTwins = await page.evaluate(() => [...document.querySelectorAll('[data-kit-core-kit]')].map((e) => e.getAttribute('data-kit-core-kit')));
    expect([...pairNames].sort()).toEqual(Object.keys(PAIRS).sort());
    expect([...kitTwins].sort()).toEqual(Object.keys(PAIRS).sort());
    const pairDiffs = [];
    for (const pair of Object.keys(PAIRS)) {
      if (pair.startsWith('LinePlot/')) continue;
      const { core, kit } = await readPair(page, pair);
      pairDiffs.push(...diffPair(pair, core, kit));
    }
    // The plot: each side hovered at 30 % of its width, so its tip shows (and does not flip).
    {
      const pair = 'LinePlot/log-iterations';
      const hover30 = async (sel) => {
        const svg = page.locator(`${sel} svg`).first();
        const box = await svg.boundingBox();
        await svg.hover({ position: { x: box.width * 0.3, y: box.height / 2 } });
        await settle();
      };
      await hover30(`[data-kit-core-pair="${pair}"]`);
      const core = await page.evaluate(readParts, pairArgs(pair, `[data-kit-core-pair="${pair}"]`));
      await hover30(`[data-kit-core-kit="${pair}"]`);
      const kit = await page.evaluate(readParts, pairArgs(pair, `[data-kit-core-kit="${pair}"]`));
      await page.mouse.move(0, 0);
      pairDiffs.push(...diffPair(pair, core, kit));
    }
    // Hovered, then focused by Tab (with the focus ring), each side in turn.
    for (const [pair, part] of Object.entries(PAIR_ACTIVE)) {
      const sides = { core: `[data-kit-core-pair="${pair}"]`, kit: `[data-kit-core-kit="${pair}"]` };
      const read = (sel, props) => page.evaluate(readParts, { sel, props, beforeProps: BEFORE_PROPS, noBox: false });
      const hovered = {};
      for (const [side, sel] of Object.entries(sides)) {
        await page.locator(`${sel} [data-kit-part="${part}"]`).hover();
        await settle();
        hovered[side] = await read(sel, PAIR_PROPS);
      }
      await page.mouse.move(0, 0);
      pairDiffs.push(...diffPair(pair, hovered.core, hovered.kit).map((d) => `${d} (hovered)`));
      const focused = {};
      for (const [side, sel] of Object.entries(sides)) {
        expect(await focusWithin(page, page, sel, `${sel} [data-kit-part="${part}"]`), `${pair}: the ${side} ${part} is :focus-visible`).toBe(true);
        await settle();
        focused[side] = await read(sel, FOCUS_PAIR_PROPS);
        await unfocus(page);
      }
      await page.mouse.move(0, 0);
      pairDiffs.push(...diffPair(pair, focused.core, focused.kit).map((d) => `${d} (focused)`));
      if (pair === 'Field/help') {
        for (const [what, r] of [
          ['hovered', hovered],
          ['focused', focused],
        ]) {
          expect(r.core?.parts.tip?.style.display, `the core help tip shows ${what}`).toBe('block');
          expect(r.kit?.parts.tip?.style.display, `the kit help tip shows ${what}`).toBe('block');
        }
      }
    }
    expect(pairDiffs, pairDiffs.slice(0, 60).join('\n')).toEqual([]);
    stage(t0, `${Object.keys(PAIRS).length} kit-vs-core pairs equal; ${Object.keys(PAIR_ACTIVE).length} of them hovered and focused too`);

    // 7. The gate can fail: one changed property in the page shows up in steps 3 and 6.
    const broken = await page.addStyleTag({ content: '[data-kit-specimen="Button/primary"] .mgk-btn{padding-left:7px}' });
    const caught = await compareAtRest(['Button/primary']);
    expect(caught.some((d) => /padding-left: page 7px/.test(d)), caught.join('\n')).toBe(true);
    await broken.evaluate((el) => el.remove());
    expect(await compareAtRest(['Button/primary'])).toEqual([]);
    const brokenPair = await page.addStyleTag({ content: '[data-kit-core-kit="Button/primary"] .mgk-btn{padding-left:7px}' });
    let r = await readPair(page, 'Button/primary');
    const caughtPair = diffPair('Button/primary', r.core, r.kit);
    expect(caughtPair.some((d) => /padding-left: core \S+ \| kit 7px/.test(d)), caughtPair.join('\n')).toBe(true);
    await brokenPair.evaluate((el) => el.remove());
    r = await readPair(page, 'Button/primary');
    expect(diffPair('Button/primary', r.core, r.kit)).toEqual([]);
    stage(t0, 'a 7 px padding change fails both comparisons; removed, both pass');

    // 8. Sign-off shots (MAGNUSIM_KIT_SHOTS): every specimen in both, every pair, the whole sheet.
    if (shots) {
      for (const n of pageNames) {
        await shoot('page', n, '');
        await shoot('frame', n, '');
      }
      for (const pair of Object.keys(PAIRS)) {
        await page.locator(`[data-kit-core-pair="${pair}"]`).locator('xpath=..').screenshot({ path: join(shots, `h14-pair-${slug(pair)}.png`) });
      }
      const size = await page.evaluate(() => {
        const row = document.querySelector('[data-kit-sheet-ready]').firstElementChild;
        return { width: Math.ceil(row.scrollWidth), height: Math.ceil(row.scrollHeight) };
      });
      await page.setViewportSize({ width: Math.max(size.width, 1500), height: Math.min(size.height, 16_000) });
      await page.screenshot({ path: join(shots, 'h14-sheet.png') });
      stage(t0, `shots saved in ${shots}`);
    }
  });

  test('@plugins gate:h14-field-widget-kit a kit field widget in the Mesh panel', async ({ page, request }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    const t0 = Date.now();
    const base = host.base;
    const form = page.locator('#panel-mesh-form .cfd-island');
    const kitInput = form.locator('[data-schema-key="fineness"] .mat-v input.mgk-input');
    const coreInput = form.locator('[data-schema-key="fineness"] .mat-v input.bc-input');
    const meshes = async () => {
      const r = await request.get(`${base}/api/mesh?project_id=${encodeURIComponent(PROJECT)}`);
      const body = await r.json();
      return body.meshes || (body.mesh ? [body.mesh] : []);
    };
    const meshOf = async (id) => (await meshes()).find((m) => String(m.id) === String(id)) || {};
    const fineness = async (id) => {
      const m = await meshOf(id);
      return m.settings ? m.settings.fineness : undefined;
    };
    const openProject = async ({ waitPlugins }) => {
      await page.goto(`${base}/#/p/${encodeURIComponent(PROJECT)}`);
      await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('#left-tree')).toContainText('Elbow', { timeout: 30_000 });
      // The project is hydrated (this does not wait for plugin UIs, which step 5 holds).
      await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
      if (waitPlugins) await page.waitForFunction(() => window.__CFD_PLUGINS_READY__ === true, null, { timeout: 60_000 });
    };
    const openMesh = async (id) => {
      const item = page.locator(`#left-tree [data-w20-mesh-item="${id}"]`).first();
      const twist = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tw').first();
      // The tree can redraw its folders as it settles: open the Meshes folder again
      // if the row is hidden, and retry the click.
      await expect(async () => {
        if (!(await item.isVisible())) await twist.click({ timeout: 2_000 });
        await item.click({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await expect(form.locator('[data-schema-key="fineness"]')).toBeVisible({ timeout: 30_000 });
    };
    let meshId = '';
    try {
      // 1. The kit field, with its plugin loaded without an error.
      await openProject({ waitPlugins: true });
      await page.locator('#wb-prefs').click();
      const wizard = page.locator('#setup-wizard');
      await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
      const row = wizard.locator(`[data-plugin-key="${KEY}"]`);
      await expect(row).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 15_000 });
      await expect(row.locator('.wiz-plugin-error')).toHaveCount(0);
      await page.locator('#wiz-skip').click();
      await expect(wizard).toBeHidden();
      await expect(page.locator('.app-toasts [data-plugin-toast]')).toHaveCount(0);

      const before = new Set((await meshes()).map((m) => String(m.id)));
      await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first().locator('.tl').click();
      await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
      await expect(form.locator('[data-schema-key="fineness"]')).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => {
          meshId = (await meshes()).map((m) => String(m.id)).find((id) => !before.has(id)) || '';
          return meshId;
        }, { timeout: 15_000 })
        .not.toBe('');
      // The engine select sits in the Advanced disclosure; a click on an open one closes it.
      const advanced = form.locator('details.mesh-advanced');
      if ((await advanced.getAttribute('open')) === null) await advanced.locator('> summary').click();
      await expect(form.locator('[data-mesh-engine="1"]')).toBeVisible();
      await form.locator('[data-mesh-engine="1"]').selectOption({ label: 'Kit demo mesher' });
      await expect
        .poll(async () => {
          const m = await meshOf(meshId);
          return String(m.ui_mesh_engine || m.settings?.advanced?.mesh_engine || '');
        }, { timeout: 15_000 })
        .toBe('kit_demo_mesher');
      await expect(kitInput).toBeVisible({ timeout: 15_000 });
      const cell = form.locator('[data-schema-key="fineness"] .mat-v');
      expect(await cell.evaluate((v) => [...v.children].map((c) => `${c.tagName.toLowerCase()}.${c.className}`))).toEqual(['span.mgk-type mgk-value-row']);
      await expect(page.locator('.app-toasts [data-plugin-toast]')).toHaveCount(0);
      stage(t0, `mesh ${meshId} on the kit demo mesher: fineness is the kit input`);

      // It matches its core neighbour in the same Advanced disclosure.
      if ((await advanced.getAttribute('open')) === null) await advanced.locator('> summary').click();
      await expect(form.locator('details.mesh-advanced[open]')).toHaveCount(1);
      const neighbour = form.locator('[data-schema-key="gap_refinement_factor"] .mat-v input.bc-input');
      await expect(neighbour).toBeVisible();
      const look = (loc) =>
        loc.evaluate((el, props) => {
          const cs = getComputedStyle(el);
          const o = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
          o['box height'] = el.getBoundingClientRect().height;
          return o;
        }, PAIR_PROPS);
      const coreLook = await look(neighbour);
      expect(coreLook['box height']).toBeGreaterThan(0);
      expect(await look(kitInput)).toEqual(coreLook);
      stage(t0, 'kit input looks like the core input next to it');

      // 2. Commit: Tab saves it.
      await kitInput.fill('4');
      await page.keyboard.press('Tab');
      await expect.poll(() => fineness(meshId), { timeout: 15_000 }).toBe(4);
      stage(t0, 'typed 4, Tab: saved');

      // 3. Escape puts the saved value back and saves nothing.
      await kitInput.fill('6');
      await kitInput.press('Escape');
      await expect(kitInput).toHaveValue('4');
      await page.waitForTimeout(1_000);
      expect(await fineness(meshId)).toBe(4);
      stage(t0, 'typed 6, Escape: shows 4, saved 4');

      // 4. After a reload.
      await page.reload();
      await openProject({ waitPlugins: true });
      await openMesh(meshId);
      await expect(kitInput).toHaveValue('4', { timeout: 15_000 });
      stage(t0, 'after a reload the kit input shows 4');

      // 5. A widget whose plugin UI loads after the form opened (the bug fix). The plugin's
      //    UI request is held until the panel shows the core input with the saved value.
      let release = () => {};
      const held = new Promise((r) => (release = r));
      let heldCount = 0;
      await page.route('**/plugins/kit-demo/ui/**', async (route) => {
        heldCount += 1;
        await held;
        await route.continue();
      });
      const registry = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/registry' && r.request().method() === 'GET', { timeout: 60_000 });
      await page.reload();
      await openProject({ waitPlugins: false });
      await registry;
      await openMesh(meshId);
      await expect(coreInput).toHaveValue('4', { timeout: 30_000 });
      await expect(kitInput).toHaveCount(0);
      expect(heldCount, 'the plugin UI request is held').toBeGreaterThan(0);
      expect(await page.evaluate(() => window.__CFD_PLUGINS_READY__ === true)).toBe(false);
      stage(t0, `plugin UI held (${heldCount} request(s)); the row shows the core input with 4`);

      const seen = [];
      const onRequest = (req) => seen.push(`${req.method()} ${req.url()}`);
      page.on('request', onRequest);
      await page.evaluate(() => {
        window.__h14MeshSettings = 0;
        window.addEventListener('cfd:mesh-settings', () => {
          window.__h14MeshSettings += 1;
        });
      });
      release();
      await expect(kitInput).toBeVisible({ timeout: 15_000 });
      // The form's own onChange saves 300 ms later; a second catches that POST too.
      await page.waitForTimeout(1_000);
      page.off('request', onRequest);
      const events = await page.evaluate(() => window.__h14MeshSettings);
      await page.unroute('**/plugins/kit-demo/ui/**');
      stage(t0, `released: the kit input showed; requests since: ${seen.length ? seen.join(', ') : 'none'}; cfd:mesh-settings events: ${events}`);
      const rebuilt = seen.filter((s) => /^\w+ \S+?\/api\/(mesh|registry)(\?|$)/.test(s));
      expect(rebuilt, 'a /api/mesh or /api/registry request came between the release and the kit input (something else rebuilt the form)').toEqual([]);
      expect(events, 'a cfd:mesh-settings event came between the release and the kit input (something else rebuilt the form)').toBe(0);
      await expect(kitInput).toHaveValue('4');
      stage(t0, 'the late widget replaced the core input with nothing else rebuilding the form');
    } finally {
      await page.unroute('**/plugins/kit-demo/ui/**').catch(() => undefined);
      if (meshId) await request.post(`${base}/api/mesh`, { data: { project_id: PROJECT, mesh_id: meshId, delete_record: true } });
    }
  });

  test('@plugins gate:h14-workspace-kit kit controls and toasts in a workspace frame', async ({ page, request }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    const t0 = Date.now();
    const base = host.base;
    const made = await request.post(`${base}/api/plugin-studies/create`, { data: { project_id: PROJECT, plugin: KEY, kind: 'kit_case', title: 'Kit check' } });
    const body = await made.json();
    expect(made.ok(), JSON.stringify(body)).toBe(true);
    const study = body.study;
    const wsUrl = `${base}/#/p/${PROJECT}/ws/${KEY}/kit/${study.id}`;
    const overlay = page.locator('#workspace-overlay');
    const frame = page.frameLocator('#workspace-frame');
    const button = frame.locator('[data-kit-button]');
    const wsToast = page.locator('#workspace-overlay [data-ws-toast]');
    const appToast = page.locator('.app-toasts .mgk-toast');
    const inside = () => page.frames().find((f) => f.url().includes(`/plugins/${KEY}/workspace/`));
    /** Whether the element at the centre of `sel` is inside `sel` (nothing draws over it). */
    const onTop = (sel) =>
      page.evaluate((s) => {
        const el = document.querySelector(s);
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
      }, sel);
    try {
      // 1. Open the study's workspace.
      await page.goto(wsUrl);
      await expect(overlay).toBeVisible({ timeout: 60_000 });
      await expect(button).toHaveText('Show a toast', { timeout: 60_000 });
      stage(t0, `workspace open for ${study.id}`);

      // 2. The frame runs the shipped kit, and the kit button has the primary look.
      const res = await inside().evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
      expect(res).toContain('/plugin-sdk/plugin-ui.js');
      expect(res).toContain('/plugin-sdk/plugin-ui.css');
      const look = await button.evaluate((b) => {
        const s = getComputedStyle(b);
        return { background: s.backgroundColor, color: s.color, size: s.fontSize, padding: s.padding };
      });
      expect(look).toEqual({ background: 'rgb(59, 91, 219)', color: 'rgb(255, 255, 255)', size: '12px', padding: '6px 10px' });
      stage(t0, 'frame loaded the kit; the button is the kit primary');

      // 3. Its toast draws inside the workspace, above the frame, and × closes it.
      await button.click();
      await expect(wsToast).toHaveCount(1);
      await expect(wsToast).toHaveClass(/(^|\s)mgk-toast(\s|$)/);
      await expect(wsToast).toHaveClass(/(^|\s)mgk-toast--success(\s|$)/);
      await expect(wsToast).toContainText('Kit toast');
      await expect(appToast).toHaveCount(0);
      expect(await onTop('#workspace-overlay [data-ws-toast]'), 'the workspace toast is on top of the frame').toBe(true);
      await wsToast.locator('.mgk-toast-close').click();
      await expect(wsToast).toHaveCount(0);
      stage(t0, 'workspace toast in the overlay, on top; × closed it');

      // 4. One at a time: a second replaces the first, and it closes by itself.
      await button.click();
      await button.click();
      await expect(wsToast).toHaveCount(1);
      // A toast drawn under a still pointer can count as hovered, which holds it.
      await page.mouse.move(0, 0);
      await page.waitForTimeout(2_000);
      await expect(wsToast).toHaveCount(1);
      await expect(wsToast).toHaveCount(0, { timeout: 4_000 });
      stage(t0, 'two quick toasts: one shown, gone by 6 s');

      // 5. App toasts draw above the workspace.
      await page.evaluate(() => window.__CFD_PLUGIN_UI__.toast('App over workspace'));
      await expect(appToast).toHaveCount(1);
      await expect(appToast).toContainText('App over workspace');
      expect(await onTop('.app-toasts .mgk-toast'), 'the app toast is on top of the workspace').toBe(true);
      await appToast.locator('.mgk-toast-close').click();
      await expect(appToast).toHaveCount(0);
      stage(t0, 'app toast above the workspace; × closed it');

      // 6. Leaving the workspace takes its toast with it.
      await button.click();
      await expect(wsToast).toHaveCount(1);
      await overlay.locator('[data-ws-back]').click();
      await expect(overlay).toBeHidden();
      await expect(wsToast).toHaveCount(0);
      await expect(appToast).toHaveCount(0);
      stage(t0, 'Back to project: no toast left');

      // 7. The switch takes Space, in a real frame.
      await page.goto(wsUrl);
      await expect(overlay).toBeVisible({ timeout: 60_000 });
      await expect(button).toBeVisible({ timeout: 60_000 });
      const switchInput = frame.locator('[data-kit-toggle] input.mgk-switch-input');
      await expect(switchInput).not.toBeChecked();
      const bodyBox = await frame.locator('body').boundingBox();
      await frame.locator('body').click({ position: { x: 10, y: Math.max(10, bodyBox.height - 10) } });
      let focused = false;
      for (let i = 0; i < 5 && !focused; i++) {
        await page.keyboard.press('Tab');
        focused = await inside().evaluate(() => !!document.activeElement && document.activeElement.matches('[data-kit-toggle] input.mgk-switch-input'));
      }
      expect(focused, 'Tab reaches the switch').toBe(true);
      await page.keyboard.press('Space');
      await expect(switchInput).toBeChecked();
      await page.keyboard.press('Space');
      await expect(switchInput).not.toBeChecked();
      stage(t0, 'Space turns the switch on and off');

      // 8. A reload shows no toast.
      await page.reload();
      await expect(overlay).toBeVisible({ timeout: 60_000 });
      await expect(button).toBeVisible({ timeout: 60_000 });
      await expect(wsToast).toHaveCount(0);
      await expect(appToast).toHaveCount(0);
      stage(t0, 'after a reload: no toast');
    } finally {
      await request.post(`${base}/api/plugin-studies/delete`, { data: { project_id: PROJECT, plugin: KEY, study_id: study.id } }).catch(() => undefined);
    }
  });
});
