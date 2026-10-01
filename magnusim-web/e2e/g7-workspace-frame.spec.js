import { expect, test } from '@playwright/test';
import { NO_GEOMETRY_PROJECT } from './prepare-projects.js';
import { startHost } from './support/host-server.mjs';

// G7, a plugin's workspace frame as the user meets it: the page has the keyboard
// once it connects and gets it back after the app's own dialogs, but never takes
// it from Settings, nor from the page body when the Queue's menu, already hidden,
// is hidden again; the page may go full screen, and the app leaves full screen
// before it asks anything; while the page says it has unsaved work
// (ws.nav.setDirty), every way out asks first (Back, the page's own Back, browser
// Back/Forward, a typed link, Home, the folder chip, opening another project,
// turning the plugin off in Settings) and Stay keeps the same page with its work
// (Stay has the focus and Enter answers it: Leave and Turn off take a click);
// Settings and the compute queue never leave it; a study deleted or a plugin
// turned off elsewhere closes it without asking; closing the tab shows the
// browser's own prompt. A second app server with the workspace fixture plugin
// (python/tests/fixtures/workspace-plugins).
const PROJECT = 'sample-project-steady-state-e2e';
const KEY = 'ws-demo';
// The page's message, without and with its own full stop: the questions read the same
// either way (one full stop after it when leaving, none inside the turn-off parentheses).
const UNSAVED = 'Chord 120 mm is not saved';
const UNSAVED_SENTENCE = `${UNSAVED}.`;
const LEAVE_COPY = `Workspace demo: ${UNSAVED}. Leaving discards them.`;
const OFF_COPY = `Its workspace is open with changes that are not saved (${UNSAVED}). Turning it off closes the workspace and discards them.`;
const LOST = 'Changes that were not saved in the workspace were lost.';

function stage(t0, msg) {
  console.log(`[g7 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

test('gate:g7-workspace-frame focus, full screen and the unsaved-work guard on every way out', async ({ page, request }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const host = await startHost({ name: 'g7', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
  const { base } = host;

  // The app's API, as another tab or a script would use it (not through this page).
  const api = async (path, data) => {
    const r = await request.post(`${base}${path}`, { data });
    const j = await r.json().catch(() => ({}));
    expect(r.ok(), `${path}: ${JSON.stringify(j)}`).toBe(true);
    return j;
  };
  const newStudy = async (kind, title) => (await api('/api/plugin-studies/create', { project_id: PROJECT, plugin: KEY, kind, title })).study;
  const setPlugin = async (on) => {
    await api(`/api/plugins/${KEY}/${on ? 'enable' : 'disable'}`, {});
    await api('/api/worker', { method: 'registry.reload', params: {} });
  };

  const overlay = page.locator('#workspace-overlay');
  const shell = overlay.locator('.ws-shell');
  const card = overlay.locator('[data-ws-error]');
  const modal = page.locator('#modal-confirm');
  const wizard = page.locator('#setup-wizard');
  const inFrame = page.frameLocator('#workspace-frame');
  const row = (id) => page.locator(`#plugin-studies-section [data-plugin-study="${id}"] > .tree-row`);
  const wsHash = (id, ws = 'bench') => `#/p/${PROJECT}/ws/${KEY}/${ws}/${id}`;
  const wsUrl = (id, ws = 'bench') => new RegExp(`#/p/${PROJECT}/ws/${KEY}/${ws}/${id}$`);
  const projectUrl = new RegExp(`#/p/${PROJECT}$`);
  const projectReady = () => page.evaluate(() => window.__CFD_PROJECT_READY__);
  const coveredInert = () => page.evaluate(() => ['#top-header', '#toolbar', '#app > .main-row'].map((s) => document.querySelector(s).inert));
  const hostFullscreen = () =>
    page.evaluate(() => (document.fullscreenElement ? document.fullscreenElement.id || document.fullscreenElement.tagName : null));

  // Open a project's workbench from a link and wait until it has loaded (again).
  const openProjectPage = async (pid) => {
    await page.evaluate(() => {
      window.__CFD_PROJECT_READY__ = null;
    });
    await page.goto(`${base}/#/p/${pid}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  };

  // The bench page of a study once it has connected. Found again after every new
  // load of the frame; `notLoad` skips the page load that was there before.
  const benchFrame = async (studyId, notLoad = null) => {
    let found = null;
    await expect
      .poll(
        async () => {
          for (const f of page.frames()) {
            if (f.isDetached() || !f.url().includes(`/plugins/${KEY}/workspace/index.html`)) continue;
            const got = await f
              .evaluate(() => ({ sid: window.__ws ? window.__ws.context.study.id : null, load: window.__benchLoadId || null }))
              .catch(() => null);
            if (got && got.sid === studyId && got.load !== notLoad) {
              found = f;
              return 'connected';
            }
          }
          return 'not yet';
        },
        { timeout: 60_000, message: `the workspace page of ${studyId} connects` },
      )
      .toBe('connected');
    await expect(shell).toHaveAttribute('data-workspace-connected', '1');
    return found;
  };
  const loadIdOf = (frame) => frame.evaluate(() => window.__benchLoadId);

  // Focus is in the workspace frame, and a key pressed now reaches its page.
  const keysReach = async (frame, key) => {
    await expect
      .poll(() => page.evaluate(() => (document.activeElement && document.activeElement.id) || ''), { message: 'focus is in the workspace frame' })
      .toBe('workspace-frame');
    await frame.evaluate(() => {
      window.__benchKeys.length = 0;
      document.getElementById('bench-keys').textContent = '';
    });
    await page.keyboard.press(key);
    await expect(inFrame.locator('#bench-keys')).toHaveText(key);
  };

  // The page marks or clears unsaved work, with its message; the workspace header shows it.
  const setDirty = async (frame, dirty, message = UNSAVED) => {
    await frame.evaluate(({ dirty, message }) => window.__ws.nav.setDirty(dirty, message), { dirty, message });
    if (dirty) {
      await expect(shell).toHaveAttribute('data-workspace-dirty', '1');
      await expect(overlay.locator('[data-ws-dirty]')).toBeVisible();
      await expect(overlay.locator('[data-ws-dirty]')).toHaveAttribute('title', message);
    } else {
      await expect(shell).not.toHaveAttribute('data-workspace-dirty', '1');
      await expect(overlay.locator('[data-ws-dirty]')).toHaveCount(0);
    }
  };

  // The id of the element that has the keyboard in the app ('workspace-frame' while its page has it).
  const focusedId = () => page.evaluate(() => (document.activeElement && document.activeElement.id) || '');

  // The app's question dialog, as the user reads it. On a question whose Yes discards the
  // work (safe), the Cancel button has the focus (Enter answers it); on any other, Yes has it.
  const expectQuestion = async (title, copy, yes, { no = 'Cancel', safe = false } = {}) => {
    await expect(modal).toBeVisible();
    await expect(page.locator('#cf-heading')).toHaveText(title);
    await expect(page.locator('#cf-copy')).toHaveText(copy);
    await expect(page.locator('#cf-confirm')).toHaveText(yes);
    await expect(page.locator('#cf-cancel')).toBeVisible();
    await expect(page.locator('#cf-cancel')).toHaveText(no);
    await expect.poll(focusedId, { message: `the ${safe ? 'Cancel' : 'Yes'} button has the focus` }).toBe(safe ? 'cf-cancel' : 'cf-confirm');
  };
  const leaveQuestion = () => expectQuestion('Leave without saving?', LEAVE_COPY, 'Leave', { no: 'Stay', safe: true });
  // A plain click: Playwright does not click a covered button, so this also proves the dialog is on top.
  const answer = async (yes) => {
    await page.locator(yes ? '#cf-confirm' : '#cf-cancel').click();
    await expect(modal).toBeHidden();
  };

  // Every time the question dialog opens: its heading, and whether anything was full screen then.
  const watchDialogs = () =>
    page.evaluate(() => {
      const m = document.getElementById('modal-confirm');
      window.__g7Dialogs = [];
      new MutationObserver(() => {
        if (!m.hidden) {
          window.__g7Dialogs.push({ heading: document.getElementById('cf-heading').textContent, fullscreen: !!document.fullscreenElement });
        }
      }).observe(m, { attributes: true, attributeFilter: ['hidden'] });
    });
  const dialogs = async () => {
    const list = await page.evaluate(() => window.__g7Dialogs || null);
    expect(list, 'the dialog watcher is still installed (the page never reloaded)').not.toBeNull();
    return list;
  };

  try {
    const bench = await newStudy('bench_case', 'Wing section');
    const tail = await newStudy('bench_case', 'Tail section');
    const scratch = await newStudy('bench_case', 'Scratch');
    const full = await newStudy('bench_case', 'Full screen');
    const silent = await newStudy('silent_case', 'Quiet one');
    stage(t0, `server up, studies ${bench.id}, ${tail.id}, ${scratch.id}, ${full.id}, ${silent.id}`);

    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await watchDialogs();

    // gate:g7-focus: opened from its tree row, the page has the keyboard at once (no click in it).
    await row(bench.id).click();
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(wsUrl(bench.id));
    let frame = await benchFrame(bench.id);
    let loadId = await loadIdOf(frame);
    // The frame's sandbox is unchanged; full screen is allowed.
    await expect(overlay.locator('#workspace-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-downloads');
    await expect(overlay.locator('#workspace-frame')).toHaveAttribute('allow', /(^|;\s*)fullscreen(;|$)/);
    await keysReach(frame, 'l');
    // After the page's own question (ws.ui.confirm) is answered, keys reach it again.
    const replaced = frame.evaluate(() =>
      window.__ws.ui.confirm({ title: 'Replace the mesh?', message: 'The old mesh is deleted.', confirmLabel: 'Replace' }),
    );
    await expectQuestion('Replace the mesh?', 'The old mesh is deleted.', 'Replace');
    await answer(false);
    expect(await replaced).toBe(false);
    await keysReach(frame, 'm');
    expect(await loadIdOf(frame)).toBe(loadId);
    // Settings opened before the page connects keeps the keyboard; closing it gives
    // the keyboard to the page. The page's module is held until Settings is open.
    await overlay.locator('[data-ws-back]').click();
    await expect(overlay).toBeHidden();
    let release = () => undefined;
    const held = new Promise((r) => (release = r));
    let asked = () => undefined;
    const requested = new Promise((r) => (asked = r));
    const mainJs = `**/plugins/${KEY}/workspace/main.js`;
    await page.route(mainJs, async (route) => {
      asked();
      await held;
      await route.continue();
    });
    await row(bench.id).click();
    await requested;
    await expect(overlay.locator('[data-ws-loading]')).toBeVisible();
    await overlay.locator('.ws-header-right #wb-prefs').click();
    await expect(wizard).toBeVisible();
    await wizard.locator('#wiz-rail li', { hasText: 'Workspace' }).click();
    expect(await page.evaluate(() => !!document.activeElement.closest('#setup-wizard'))).toBe(true);
    await expect(shell).not.toHaveAttribute('data-workspace-connected', '1');
    release();
    frame = await benchFrame(bench.id, loadId);
    // Two frames after it connected: the app has had its chance to focus the page, and did not.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await page.evaluate(() => !!document.activeElement.closest('#setup-wizard'))).toBe(true);
    await expect(wizard).toBeVisible();
    loadId = await loadIdOf(frame);
    await wizard.locator('#wiz-skip').click();
    await expect(wizard).toBeHidden();
    await keysReach(frame, 'n');
    expect(await loadIdOf(frame)).toBe(loadId);
    await page.unroute(mainJs);
    stage(t0, 'g7-focus: keys at connect, after a page dialog and after Settings');

    // gate:g7-no-op-rehide: a click on the header's plain text (the plugin's name) gives the
    // keyboard to the page body. The Queue's sync hides its menu again although it is hidden
    // already (as the app does on any queue update): the frame must not take the keyboard back.
    const activeTag = () => page.evaluate(() => (document.activeElement ? document.activeElement.tagName : ''));
    const twoFrames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const plainText = overlay.locator('[data-ws-crumb] .ws-plugin');
    await expect(plainText).toHaveText('Workspace demo');
    await plainText.click();
    await expect.poll(activeTag, { message: 'the page body has the keyboard' }).toBe('BODY');
    const wasHidden = await page.evaluate(() => {
      const chip = document.getElementById('job-queue-chip');
      const before = chip.hidden;
      chip.hidden = true;
      return before;
    });
    expect(wasHidden, 'the Queue menu was hidden already').toBe(true);
    // The app would act on the next frame; give it two and a little more.
    await twoFrames();
    await page.waitForTimeout(300);
    expect(await activeTag()).toBe('BODY');
    await frame.evaluate(() => {
      window.__benchKeys.length = 0;
      document.getElementById('bench-keys').textContent = '';
    });
    await page.keyboard.press('k');
    await twoFrames();
    expect(await frame.evaluate(() => window.__benchKeys.slice())).toEqual([]);
    await expect(inFrame.locator('#bench-keys')).toHaveText('');
    // The Queue really closing (opened from the header, closed by a click outside it) still
    // gives the keyboard back to the page.
    await overlay.locator('.ws-header-right #btn-queue').click();
    await expect(page.locator('#job-queue-chip')).toBeVisible();
    await plainText.click();
    await expect(page.locator('#job-queue-chip')).toBeHidden();
    await keysReach(frame, 'k');
    expect(await loadIdOf(frame)).toBe(loadId);
    stage(t0, 'g7-no-op-rehide');

    // gate:g7-settings-not-exit: Settings opens over unsaved work without asking, and the same page is there after.
    await setDirty(frame, true);
    let count = (await dialogs()).length;
    await overlay.locator('.ws-header-right #wb-prefs').click();
    await expect(wizard).toBeVisible();
    await expect(modal).toBeHidden();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('#workspace-frame')).toHaveCount(1);
    await wizard.locator('#wiz-skip').click();
    await expect(wizard).toBeHidden();
    expect(await loadIdOf(frame)).toBe(loadId);
    await expect(shell).toHaveAttribute('data-workspace-dirty', '1');
    expect((await dialogs()).length).toBe(count);
    stage(t0, 'g7-settings-not-exit');

    // gate:g7-dirty-header-back: Back asks with Stay focused; Enter answers Stay, which keeps
    // the same page with its work and gives it the keyboard.
    await overlay.locator('[data-ws-back]').click();
    await leaveQuestion();
    await page.keyboard.press('Enter');
    await expect(modal).toBeHidden();
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(wsUrl(bench.id));
    expect(await loadIdOf(frame)).toBe(loadId);
    await expect(shell).toHaveAttribute('data-workspace-dirty', '1');
    await keysReach(frame, 'p');
    // The page's own question after it is a plain one again, even when the page asks for the
    // leave question's Stay and safe (and a notice): Cancel, Yes focused, Enter answers Yes.
    const plain = frame.evaluate(() =>
      window.__ws.ui.confirm({
        title: 'Replace the mesh?',
        message: 'The old mesh is deleted.',
        confirmLabel: 'Replace',
        safe: true,
        no: 'Stay',
        cancelLabel: 'Stay',
        notice: true,
      }),
    );
    await expectQuestion('Replace the mesh?', 'The old mesh is deleted.', 'Replace');
    await page.keyboard.press('Enter');
    await expect(modal).toBeHidden();
    expect(await plain).toBe(true);
    expect(await loadIdOf(frame)).toBe(loadId);
    // A click on Stay keeps it too.
    await overlay.locator('[data-ws-back]').click();
    await leaveQuestion();
    await answer(false);
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(wsUrl(bench.id));
    expect(await loadIdOf(frame)).toBe(loadId);
    await expect(shell).toHaveAttribute('data-workspace-dirty', '1');
    await keysReach(frame, 'o');
    // Leave: the workbench as it was, its header back and usable.
    await overlay.locator('[data-ws-back]').click();
    await leaveQuestion();
    await answer(true);
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(projectUrl);
    await expect(page.locator('#top-header .top-right #btn-queue')).toBeVisible();
    await expect(page.locator('#top-header .top-right #wb-prefs')).toBeVisible();
    expect(await coveredInert()).toEqual([false, false, false]);
    stage(t0, 'g7-dirty-header-back');

    // gate:g7-dirty-frame-back: the page's own Back (ws.nav.back) asks too, and tells the page what the user chose.
    // Its message ends with a full stop this time: the question adds no second one (LEAVE_COPY).
    await row(bench.id).click();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setDirty(frame, true, UNSAVED_SENTENCE);
    const stayed = frame.evaluate(() => window.__ws.nav.back());
    await leaveQuestion();
    await answer(false);
    expect(await stayed).toBe(false);
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(wsUrl(bench.id));
    expect(await loadIdOf(frame)).toBe(loadId);
    // Leave: the workspace closes; its page unloads, so the call may never be answered.
    const left = frame.evaluate(() => window.__ws.nav.back()).then(
      (v) => v,
      () => 'unloaded',
    );
    await leaveQuestion();
    await answer(true);
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(projectUrl);
    expect([true, 'unloaded']).toContain(await left);
    // A clean page's Back closes it without a question.
    await row(bench.id).click();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    count = (await dialogs()).length;
    await frame.evaluate(() => {
      void window.__ws.nav.back().catch(() => undefined);
    });
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(projectUrl);
    expect((await dialogs()).length).toBe(count);
    stage(t0, 'g7-dirty-frame-back');

    // gate:g7-dirty-history: browser Back asks while the address and the page stay; Leave goes where the user was going.
    await row(bench.id).click();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setDirty(frame, true);
    await page.goBack();
    await leaveQuestion();
    await expect(page).toHaveURL(wsUrl(bench.id));
    expect(await loadIdOf(frame)).toBe(loadId);
    await answer(false);
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(wsUrl(bench.id));
    expect(await loadIdOf(frame)).toBe(loadId);
    await page.goBack();
    await leaveQuestion();
    await answer(true);
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(projectUrl);
    // Forward reopens it clean, and Back from a clean page does not ask.
    await page.goForward();
    await expect(overlay).toBeVisible();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await expect(shell).not.toHaveAttribute('data-workspace-dirty', '1');
    count = (await dialogs()).length;
    await page.goBack();
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(projectUrl);
    expect((await dialogs()).length).toBe(count);
    // Forward asks too: at the page, a typed project link, Back to the page, unsaved work, Forward.
    await page.goForward();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await page.goto(`${base}/#/p/${PROJECT}`);
    await expect(overlay).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(wsUrl(bench.id));
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setDirty(frame, true);
    await page.goForward();
    await leaveQuestion();
    await expect(page).toHaveURL(wsUrl(bench.id));
    await answer(false);
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(wsUrl(bench.id));
    expect(await loadIdOf(frame)).toBe(loadId);
    // Stay put the page back as the newest entry, so Forward has nowhere to go now. Clean,
    // Back to the project and Back to the page make a Forward entry again; then Forward, Leave.
    await setDirty(frame, false);
    await page.goBack();
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(projectUrl);
    await page.goBack();
    await expect(page).toHaveURL(wsUrl(bench.id));
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setDirty(frame, true);
    await page.goForward();
    await leaveQuestion();
    await answer(true);
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(projectUrl);
    stage(t0, 'g7-dirty-history');

    // gate:g7-dirty-typed-url: a typed link asks before the app acts on it (the guard runs
    // first): Stay leaves the project as it was, with no request to open another one.
    await row(bench.id).click();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setDirty(frame, true);
    const opens = [];
    const onRequest = (r) => {
      if (r.url().includes('/api/project/open')) opens.push(r.url());
    };
    page.on('request', onRequest);
    await page.goto(`${base}/#/p/${NO_GEOMETRY_PROJECT}`);
    await leaveQuestion();
    await answer(false);
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(wsUrl(bench.id));
    expect(await projectReady()).toBe(PROJECT);
    expect(await loadIdOf(frame)).toBe(loadId);
    expect(opens).toEqual([]);
    page.off('request', onRequest);
    // Another study's workspace in the same project would replace the page: it asks too.
    await page.goto(`${base}/${wsHash(tail.id)}`);
    await leaveQuestion();
    await answer(false);
    await expect(page).toHaveURL(wsUrl(bench.id));
    await expect(overlay.locator('[data-ws-title]')).toHaveText('Wing section');
    expect(await loadIdOf(frame)).toBe(loadId);
    // The same workspace spelled another way (%2D for "-") is not a way out: no question.
    count = (await dialogs()).length;
    await page.goto(`${base}/#/p/${PROJECT}/ws/ws%2Ddemo/bench/${bench.id}`);
    await expect(page).toHaveURL(new RegExp(`/ws/ws%2Ddemo/bench/${bench.id}$`));
    await page.waitForTimeout(500);
    await expect(modal).toBeHidden();
    expect((await dialogs()).length).toBe(count);
    await expect(overlay).toBeVisible();
    expect(await loadIdOf(frame)).toBe(loadId);
    await expect(shell).toHaveAttribute('data-workspace-dirty', '1');
    stage(t0, 'g7-dirty-typed-url');

    // gate:g7-dirty-home: the covered workbench is inert (Shift+Tab never reaches Home),
    // and Home and the folder chip ask (clicked from script, which inert does not stop).
    expect(await coveredInert()).toEqual([true, true, true]);
    await inFrame.locator('#bench-title').click();
    await expect.poll(() => page.evaluate(() => (document.activeElement && document.activeElement.id) || '')).toBe('workspace-frame');
    const reached = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      reached.push(
        await page.evaluate(() => {
          const a = document.activeElement;
          return { id: (a && (a.id || a.tagName)) || '', covered: !!(a && a.closest('#top-header, #toolbar, #app > .main-row')) };
        }),
      );
    }
    expect(
      reached.filter((a) => a.id === 'wb-home' || a.covered),
      JSON.stringify(reached),
    ).toEqual([]);
    await page.evaluate(() => document.getElementById('wb-home').click());
    await leaveQuestion();
    // Cancel, then the folder chip before the app's dialogs have moved on (the next task):
    // it still asks. Clicked in that gap it once did nothing at all.
    await page.evaluate(async () => {
      document.getElementById('cf-cancel').click();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      document.getElementById('folder-chip').click();
    });
    await leaveQuestion();
    await answer(false);
    await expect(overlay).toBeVisible();
    await expect(page.locator('#home')).toBeHidden();
    expect(await projectReady()).toBe(PROJECT);
    expect(await loadIdOf(frame)).toBe(loadId);
    await page.evaluate(() => document.getElementById('folder-chip').click());
    await leaveQuestion();
    await answer(true);
    await expect(page.locator('#home')).toBeVisible();
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(/#\/folder\/My%20Projects$/);
    stage(t0, 'g7-dirty-home');

    // gate:g7-dirty-open-project: opening another project asks; a caller that must not ask is refused.
    await openProjectPage(PROJECT);
    await row(bench.id).click();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setDirty(frame, true);
    const openOther = (askToLeave) =>
      page.evaluate(
        async ({ pid, askToLeave }) => {
          const opts = { reloadIfNeeded: false };
          if (askToLeave !== null) opts.askToLeave = askToLeave;
          const r = await window.__CFD_HOME__.open(pid, opts);
          return { ok: !!(r && r.ok), stayed: !!(r && r.stayed), error: (r && r.error) || null };
        },
        { pid: NO_GEOMETRY_PROJECT, askToLeave },
      );
    const refused = { ok: false, stayed: true, error: 'The open workspace has unsaved changes.' };
    count = (await dialogs()).length;
    expect(await openOther(false)).toEqual(refused);
    await expect(modal).toBeHidden();
    expect((await dialogs()).length).toBe(count);
    expect(await projectReady()).toBe(PROJECT);
    await expect(overlay).toBeVisible();
    expect(await loadIdOf(frame)).toBe(loadId);
    let opened = openOther(null);
    await leaveQuestion();
    await answer(false);
    expect(await opened).toEqual(refused);
    await expect(overlay).toBeVisible();
    expect(await projectReady()).toBe(PROJECT);
    expect(await loadIdOf(frame)).toBe(loadId);
    opened = openOther(null);
    await leaveQuestion();
    await answer(true);
    expect((await opened).stayed).toBe(false);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, NO_GEOMETRY_PROJECT, { timeout: 60_000 });
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`#/p/${NO_GEOMETRY_PROJECT}$`));
    stage(t0, 'g7-dirty-open-project');

    // gate:g7-queue-never-leaves: a job queued in another project is started (or dropped)
    // by the server; the page with unsaved work is never left and nothing asks.
    await openProjectPage(PROJECT);
    await row(bench.id).click();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setDirty(frame, true);
    count = (await dialogs()).length;
    const queued = await api('/api/compute-queue', { item: { kind: 'mesh', project_id: NO_GEOMETRY_PROJECT, mesh_id: 'mesh_1' } });
    const jobId = queued.item.id;
    const seen = [];
    await expect
      .poll(
        async () => {
          seen.push(
            await page.evaluate(() => ({
              ready: window.__CFD_PROJECT_READY__,
              open: !document.getElementById('workspace-overlay').hidden,
              asking: !document.getElementById('modal-confirm').hidden,
            })),
          );
          const q = await (await request.get(`${base}/api/compute-queue`)).json();
          return q.items.some((i) => i.id === jobId) ? 'queued' : 'left';
        },
        { timeout: 30_000, intervals: [500, 1000], message: 'the queued job leaves the queue' },
      )
      .toBe('left');
    expect(
      seen.filter((s) => s.ready !== PROJECT || !s.open || s.asking),
      JSON.stringify(seen),
    ).toEqual([]);
    expect((await dialogs()).length).toBe(count);
    await expect(overlay).toBeVisible();
    expect(await projectReady()).toBe(PROJECT);
    expect(await loadIdOf(frame)).toBe(loadId);
    await expect(shell).toHaveAttribute('data-workspace-dirty', '1');
    stage(t0, 'g7-queue-never-leaves');

    // gate:g7-dirty-plugin-off: turning the plugin off in Settings asks, above Settings, with
    // Cancel focused; Enter or a click on Cancel sends nothing and keeps the page; a click on
    // Turn off closes it into the "is off" card.
    const disables = [];
    const onDisable = (r) => {
      if (r.url().includes(`/api/plugins/${KEY}/disable`)) disables.push(r.method());
    };
    page.on('request', onDisable);
    await overlay.locator('.ws-header-right #wb-prefs').click();
    await expect(wizard).toBeVisible();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    const pluginRow = wizard.locator(`[data-plugin-key="${KEY}"]`);
    const toggle = pluginRow.locator(`[data-plugin-toggle="${KEY}"]`);
    await expect(pluginRow).toHaveAttribute('data-plugin-status', 'enabled');
    await toggle.click();
    await expectQuestion('Turn off Workspace demo?', OFF_COPY, 'Turn off', { safe: true });
    await page.keyboard.press('Enter');
    await expect(modal).toBeHidden();
    await expect(wizard).toBeVisible();
    await expect(pluginRow).toHaveAttribute('data-plugin-status', 'enabled');
    await expect(toggle).toHaveText('Disable');
    expect(await frame.evaluate(() => window.__ws.project.info().then((i) => i.id))).toBe(PROJECT);
    await expect(shell).toHaveAttribute('data-workspace-connected', '1');
    expect(await loadIdOf(frame)).toBe(loadId);
    await expect(shell).toHaveAttribute('data-workspace-dirty', '1');
    expect(disables).toEqual([]);
    // The page's message now ends with a full stop: the parentheses leave it out, so the
    // question reads the same (OFF_COPY), with no full stop before the ")".
    await setDirty(frame, true, UNSAVED_SENTENCE);
    // A click on Cancel does the same.
    await toggle.click();
    await expectQuestion('Turn off Workspace demo?', OFF_COPY, 'Turn off', { safe: true });
    await answer(false);
    await expect(pluginRow).toHaveAttribute('data-plugin-status', 'enabled');
    await expect(toggle).toHaveText('Disable');
    expect(await frame.evaluate(() => window.__ws.project.info().then((i) => i.id))).toBe(PROJECT);
    await expect(shell).toHaveAttribute('data-workspace-connected', '1');
    expect(await loadIdOf(frame)).toBe(loadId);
    expect(disables).toEqual([]);
    await toggle.click();
    await expectQuestion('Turn off Workspace demo?', OFF_COPY, 'Turn off', { safe: true });
    await answer(true);
    await expect(pluginRow).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 });
    // One request in all: neither Enter nor Cancel sent one.
    expect(disables).toEqual(['POST']);
    page.off('request', onDisable);
    await wizard.locator('#wiz-skip').click();
    await expect(wizard).toBeHidden();
    await expect(card.locator('h2')).toHaveText('Workspace demo is off.');
    await expect(overlay.locator('#workspace-frame')).toHaveCount(0);
    stage(t0, 'g7-dirty-plugin-off: in Settings');

    // gate:g7-try-again (plugin off): there is no page, so nothing to lose and no question.
    count = (await dialogs()).length;
    let relisted = page.waitForResponse((r) => r.url() === `${base}/api/plugins`);
    await card.locator('[data-ws-retry]').click();
    await relisted;
    await expect(card.locator('h2')).toHaveText('Workspace demo is off.');
    expect((await dialogs()).length).toBe(count);

    // gate:g7-dirty-plugin-off (elsewhere): turned off by another tab or a script, the page
    // closes into the card when this tab is back in front, with no question; with unsaved
    // work the card says it was lost.
    await setPlugin(true);
    await card.locator('[data-ws-retry]').click();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setPlugin(false);
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(card.locator('h2')).toHaveText('Workspace demo is off.');
    await expect(card).not.toContainText(LOST);
    await expect(overlay.locator('#workspace-frame')).toHaveCount(0);
    await setPlugin(true);
    await card.locator('[data-ws-retry]').click();
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await setDirty(frame, true);
    await setPlugin(false);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(card.locator('h2')).toHaveText('Workspace demo is off.');
    await expect(card).toContainText(LOST);
    await expect(overlay.locator('#workspace-frame')).toHaveCount(0);
    expect((await dialogs()).length).toBe(count);
    // On again for the steps after this.
    await setPlugin(true);
    relisted = page.waitForResponse((r) => r.url() === `${base}/api/plugins`);
    await card.locator('[data-ws-retry]').click();
    await relisted;
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await expect(shell).not.toHaveAttribute('data-workspace-dirty', '1');
    stage(t0, 'g7-dirty-plugin-off: elsewhere');

    // gate:g7-dirty-study-deleted: deleted elsewhere, the page closes into the card without a
    // question (there is nothing left to save to), and says the unsaved work was lost.
    await page.goto(`${base}/${wsHash(scratch.id)}`);
    frame = await benchFrame(scratch.id);
    await setDirty(frame, true);
    count = (await dialogs()).length;
    await api('/api/plugin-studies/delete', { project_id: PROJECT, plugin: KEY, study_id: scratch.id });
    // The page's next study call finds it gone (the host closes the frame before it answers).
    await frame.evaluate(() => {
      void window.__ws.study.get().catch(() => undefined);
    });
    await expect(card.locator('h2')).toHaveText('This study no longer exists.');
    await expect(card).toContainText(LOST);
    await expect(overlay.locator('#workspace-frame')).toHaveCount(0);
    await card.locator('[data-ws-error-back]').click();
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(projectUrl);
    expect((await dialogs()).length).toBe(count);
    stage(t0, 'g7-dirty-study-deleted');

    // gate:g7-fullscreen: the page may go full screen (allow="fullscreen"); the app leaves full
    // screen before it shows a dialog, and full screen ends with the frame.
    await page.goto(`${base}/${wsHash(full.id)}`);
    frame = await benchFrame(full.id);
    expect(await frame.evaluate(() => document.fullscreenEnabled)).toBe(true);
    const fsState = inFrame.locator('#bench-fs');
    await inFrame.locator('#bench-fullscreen').click();
    await expect(fsState).toHaveText(/^(entered|on|failed: .+)$/, { timeout: 15_000 });
    const outcome = String(await fsState.textContent());
    const entered = !outcome.startsWith('failed');
    if (entered) {
      await expect.poll(hostFullscreen).toBe('workspace-frame');
      await expect(shell).toHaveAttribute('data-workspace-fullscreen', '1');
    } else {
      test.info().annotations.push({
        type: 'g7-fullscreen',
        description: `headless Chromium did not enter full screen (${outcome}); the permission (document.fullscreenEnabled in the frame) was checked`,
      });
    }
    count = (await dialogs()).length;
    const confirmed = frame.evaluate(() =>
      window.__ws.ui.confirm({ title: 'Replace the mesh?', message: 'The old mesh is deleted.', confirmLabel: 'Replace' }),
    );
    // After the leave and turn-off questions, a plain one: Cancel, with Yes focused.
    await expectQuestion('Replace the mesh?', 'The old mesh is deleted.', 'Replace');
    expect(await hostFullscreen()).toBeNull();
    const shown = await dialogs();
    expect(shown.length).toBe(count + 1);
    expect(shown[shown.length - 1]).toEqual({ heading: 'Replace the mesh?', fullscreen: false });
    await expect(shell).not.toHaveAttribute('data-workspace-fullscreen', '1');
    await answer(true);
    expect(await confirmed).toBe(true);
    if (entered) await expect(fsState).toHaveText('off');
    // Full screen again, then the study is deleted: full screen ends with the frame.
    await frame.evaluate(() => {
      document.getElementById('bench-fs').textContent = '';
    });
    await inFrame.locator('#bench-fullscreen').click();
    await expect(fsState).toHaveText(entered ? /^(entered|on)$/ : /^failed: .+$/, { timeout: 15_000 });
    if (entered) await expect.poll(hostFullscreen).toBe('workspace-frame');
    await api('/api/plugin-studies/delete', { project_id: PROJECT, plugin: KEY, study_id: full.id });
    await frame.evaluate(() => {
      void window.__ws.study.get().catch(() => undefined);
    });
    await expect(card.locator('h2')).toHaveText('This study no longer exists.');
    await expect(card).not.toContainText(LOST);
    await expect(overlay.locator('#workspace-frame')).toHaveCount(0);
    await expect.poll(hostFullscreen).toBeNull();
    await expect(shell).not.toHaveAttribute('data-workspace-fullscreen', '1');
    await card.locator('[data-ws-error-back]').click();
    await expect(overlay).toBeHidden();
    stage(t0, `g7-fullscreen (${entered ? 'entered' : outcome})`);

    // gate:g7-try-again: a page that never connects shows the card; Try again asks nothing.
    await page.goto(`${base}/${wsHash(silent.id, 'silent')}`);
    await expect(card.locator('h2')).toHaveText("Workspace demo didn't start.", { timeout: 60_000 });
    count = (await dialogs()).length;
    await card.locator('[data-ws-retry]').click();
    await expect(overlay.locator('[data-ws-loading]')).toBeVisible();
    await expect(card.locator('h2')).toHaveText("Workspace demo didn't start.", { timeout: 15_000 });
    expect((await dialogs()).length).toBe(count);
    stage(t0, 'g7-try-again');

    // gate:g7-beforeunload: with unsaved work, closing the tab shows the browser's own prompt
    // (never the page's text); Stay keeps everything. Clean, the tab closes without one.
    await page.goto(`${base}/${wsHash(bench.id)}`);
    frame = await benchFrame(bench.id, loadId);
    loadId = await loadIdOf(frame);
    await inFrame.locator('#bench-title').click();
    await setDirty(frame, true);
    const prompts = [];
    const onDialog = (d) => {
      prompts.push({ type: d.type(), message: d.message() });
      void d.dismiss().catch(() => undefined);
    };
    page.on('dialog', onDialog);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => prompts.length, { message: 'the browser asks before closing the tab' }).toBe(1);
    expect(prompts[0].type).toBe('beforeunload');
    expect(prompts[0].message).not.toContain(UNSAVED);
    expect(page.isClosed()).toBe(false);
    await expect(overlay).toBeVisible();
    expect(await loadIdOf(frame)).toBe(loadId);
    await setDirty(frame, false);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => page.isClosed(), { message: 'the tab closes' }).toBe(true);
    expect(prompts.length).toBe(1);
    page.off('dialog', onDialog);
    stage(t0, 'g7-beforeunload');
  } finally {
    host.stop();
  }
});
