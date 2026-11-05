// The page-ready guard against an unstyled app page (docs/TESTING.md, "An unstyled page").
//
// index.html loads the app's own stylesheets (/src/theme/tokens.css, /src/style.css) with
// <link>. When one of those requests fails (on Windows a long, loaded run fails it with
// net::ERR_NO_BUFFER_SPACE: the PC is out of socket buffers), `.main-row` and
// `.viewport-wrap` lose their `position`, the 3D view's canvas (vtk's full-window container,
// inline `position:absolute; 100%`) covers the whole window, and the test's next click
// retries until its timeout ("<canvas> … intercepts pointer events"), minutes later.
//
// ensureStyled(page) checks, with one evaluate per document, that every stylesheet the
// page links from its own origin applied. When one did not, it logs which and why and reloads
// the page once; when the page is still unstyled it throws at once, naming the stylesheet and
// its failure. The page-ready helpers call it after they open the app (core: appReady,
// two-plates.js setup, compute-slot.js and link-streams.js openers; CAD: openProject,
// newPartFromTree), and the harness's `test` (stress.js, so plugin-suite.js too) runs it after
// every page.goto and page.reload of each page of the test's context.
//
// Dependency-free on purpose: the core's harness and CAD's own Playwright both use it.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @typedef {object} StyleWatch
 * @property {number} navigations  new documents asked for in the page's main frame (navigation requests)
 * @property {number} checked   the `navigations` count whose document was found styled (-1: none yet)
 * @property {Map<string, string>} failures  stylesheet URL -> why its last request failed
 * @property {((options?: object) => Promise<unknown>) | null} reload  the page's own reload (guardNavigations wraps page.reload)
 * @property {boolean} guarded  guardNavigations wrapped the page's goto and reload
 */

/** @type {WeakMap<object, StyleWatch>} */
const watches = new WeakMap();

/** Wait conditions after which a navigation has loaded the document: its stylesheets applied or failed. */
const LOADED = new Set([undefined, 'load', 'networkidle']);

/**
 * The page's stylesheet watch, made at the first call: it counts the new documents the page's
 * main frame asks for and keeps why a stylesheet request failed (the browser's net:: error, or
 * the HTTP status). A new document's request comes before its goto or reload can resolve, so a
 * check never takes a new document for the one it checked (Playwright does not promise the same
 * of the `load` event); a route change in the address's hash asks for none. A redirect or a
 * navigation that fails only adds a check.
 * @param {any} page  a Playwright Page
 * @returns {StyleWatch}
 */
export function watchStyles(page) {
  const known = watches.get(page);
  if (known) return known;
  /** @type {StyleWatch} */
  const watch = { navigations: 0, checked: -1, failures: new Map(), reload: null, guarded: false };
  watches.set(page, watch);
  page.on('request', (req) => {
    if (!req.isNavigationRequest()) return;
    try {
      // A workspace iframe's navigations are not the page's; a service worker's request has no frame (throws).
      if (req.frame() === page.mainFrame()) watch.navigations += 1;
    } catch {
      /* not a frame's request */
    }
  });
  page.on('requestfailed', (req) => {
    if (req.resourceType() === 'stylesheet') watch.failures.set(req.url(), req.failure()?.errorText || 'the request failed');
  });
  page.on('response', (res) => {
    if (res.request().resourceType() !== 'stylesheet') return;
    if (res.status() >= 400) watch.failures.set(res.url(), `HTTP ${res.status()}`);
    else watch.failures.delete(res.url());
  });
  return watch;
}

/**
 * Runs in the page: the URLs of the stylesheets the page links from its own origin that did
 * not apply (no sheet, or no rules), or null while the document is still loading (a
 * stylesheet still on its way has no sheet yet either).
 */
function pageStylesMissing() {
  if (document.readyState !== 'complete') return null;
  const missing = [];
  for (const link of document.querySelectorAll('link[rel~="stylesheet" i][href]')) {
    if (link.disabled) continue;
    let url;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    if (url.origin !== location.origin) continue;
    let rules = 0;
    try {
      rules = link.sheet ? link.sheet.cssRules.length : 0;
    } catch {
      // Chromium keeps an empty sheet for a link whose request failed, and reading its rules
      // throws a SecurityError; a same-origin sheet that loaded is always readable.
      rules = 0;
    }
    if (!rules) missing.push(url.href);
  }
  return missing;
}

/** The page's missing stylesheets, or null for no verdict (still loading, navigated away, closed). */
async function missingStyles(page) {
  try {
    return await page.evaluate(pageStylesMissing);
  } catch {
    // A navigation destroyed the context, or the page closed: the guard never fails a test on its own account.
    return null;
  }
}

function pathOf(href) {
  try {
    const u = new URL(href);
    return u.pathname + u.search;
  } catch {
    return href;
  }
}

/** "/src/style.css did not load (net::ERR_NO_BUFFER_SPACE)", for each missing stylesheet. */
function described(missing, watch) {
  return missing.map((href) => `${pathOf(href)} did not load (${watch.failures.get(href) ?? 'no request error seen'})`).join('; ');
}

/** Why a test stops on an unstyled page. */
export function unstyledMessage(what, { afterReload = true } = {}) {
  return (
    `The app page is unstyled${afterReload ? ', also after a reload' : ''}: ${what}. ` +
    "Without the app's stylesheets the 3D view's canvas covers the whole window and every click " +
    'would wait out the test\'s timeout, so the test stops here. On Windows a long, loaded run fails ' +
    'these requests with net::ERR_NO_BUFFER_SPACE (out of socket buffers): rerun the test alone.'
  );
}

/**
 * Checks that the app page's own stylesheets applied: one evaluate per document (a later call
 * on the same document returns at once). When one did not, it logs which and why, reloads
 * the page once and checks again; still unstyled, it throws (unstyledMessage) instead of
 * leaving the test's next click to time out.
 * @param {any} page  a Playwright Page
 * @param {{ reload?: boolean, log?: (line: string) => void }} [opts]  `reload: false` throws at once
 * @returns {Promise<'styled' | 'reloaded' | 'unknown'>}  'reloaded': the page was reloaded (and is
 *   styled), so a caller waits for the app again; 'unknown': no verdict yet (the document is still
 *   loading), a later call checks again
 */
export async function ensureStyled(page, { reload = true, log = (line) => console.log(line) } = {}) {
  const watch = watchStyles(page);
  if (watch.checked === watch.navigations) return 'styled';
  const navigations = watch.navigations;
  const missing = await missingStyles(page);
  if (missing === null) return 'unknown';
  if (!missing.length) {
    watch.checked = navigations;
    return 'styled';
  }
  const what = described(missing, watch);
  if (!reload) throw new Error(unstyledMessage(what, { afterReload: false }));
  log(`[e2e] the app page is unstyled: ${what}; reloading it once`);
  await (watch.reload ?? ((options) => page.reload(options)))();
  const after = await missingStyles(page);
  if (after === null) return 'reloaded';
  if (after.length) throw new Error(unstyledMessage(described(after, watch)));
  watch.checked = watch.navigations;
  log('[e2e] the reload styled the page');
  return 'reloaded';
}

/**
 * Runs ensureStyled after each page.goto and page.reload of `page` that waits for the load
 * (the default): the test's first look at the app is a styled page, or it stops at the goto
 * with the reason. A goto that waits only for 'commit' or 'domcontentloaded' is left alone
 * (its test may be holding a request on purpose). Idempotent.
 * @template P
 * @param {P} page  a Playwright Page
 * @returns {P}
 */
export function guardNavigations(page) {
  const p = /** @type {any} */ (page);
  const watch = watchStyles(p);
  if (watch.guarded) return page;
  watch.guarded = true;
  const goto = p.goto.bind(p);
  const reload = p.reload.bind(p);
  watch.reload = reload;
  p.goto = async (url, options) => {
    const res = await goto(url, options);
    if (LOADED.has(options?.waitUntil)) await ensureStyled(p);
    return res;
  };
  p.reload = async (options) => {
    const res = await reload(options);
    if (LOADED.has(options?.waitUntil)) await ensureStyled(p);
    return res;
  };
  return page;
}

/**
 * `base` (a Playwright `test`) whose test page, and every page opened in its context later (a
 * popup, a second tab), is guarded (guardNavigations). A context the test makes itself
 * (browser.newContext()) is not.
 * @template T
 * @param {T} base
 * @returns {T}
 */
export function withStyleGuard(base) {
  return /** @type {any} */ (base).extend({
    context: async ({ context }, use) => {
      context.on('page', (page) => void guardNavigations(page));
      await use(context);
    },
    page: async ({ page }, use) => {
      guardNavigations(page);
      await use(page);
    },
  });
}
