import { expect, test } from '@playwright/test';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { serverStream, stager, watchRequests } from './support/link-streams.js';

// A plugin page in a tab the user leaves keeps hearing the case it follows. A tab lets its one
// event stream go a few seconds after it is hidden (the browser's six connections to the app
// are shared by every tab), unless a channel is pinned: a case's was not, so a tab hidden
// while its case ran lost every event meanwhile (Airfoil's residual plot kept a gap for good,
// and a case that started meanwhile still said "queued"). A followed case that has not ended
// keeps the stream now, and once it has ended the hidden tab lets it go.
// No WSL: the case is the test's. The app's case list and status answer it (page routes),
// and its events go out on the server's own case channel: MAGNUSIM_TEST_EVENT_HUB's
// POST /api/test/plugin-case-event puts each on the bus the channel reads, as the runner
// does. The Foam demo test plugin (python/tests/fixtures/foam-plugins) follows it and lists
// what it hears in #events.

const stage = stager('connection-limit-case');
const JOB = 'fc-mg1abc2d-0a1b2c';

/** The tab is hidden (the user went to another tab or app), or shown again: it says so, as the browser does. */
function setHidden(tab, hidden) {
  return tab.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test.describe('a followed plugin case in a tab the user leaves', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    stage.reset();
    host = await startHost({
      name: 'connection-limit-case',
      tmp: e2eTemp('connection-limit-case'),
      pluginsFrom: 'python/tests/fixtures/foam-plugins',
      env: { MAGNUSIM_TEST_EVENT_HUB: '1' },
    });
    stage(`server up at ${host.base}`);
  });
  test.afterAll(() => host?.stop());

  test('every event of the running case reaches its page while the tab is hidden; once it has ended the tab lets its stream go', async ({ page, request }) => {
    test.setTimeout(300_000);
    const p = await request.post(`${host.base}/api/project`, { data: { title: 'Case in a hidden tab', folder: 'My Projects', units: 'Metric', category: 'Other' } });
    const pj = await p.json();
    expect(p.ok(), JSON.stringify(pj)).toBe(true);
    const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pj.id, plugin: 'foam-demo', kind: 'cavity_case', title: 'Cavity 1' } });
    const sj = await s.json();
    expect(s.ok(), JSON.stringify(sj)).toBe(true);
    const scope = { project_id: pj.id, plugin: 'foam-demo', study_id: sj.study.id };
    const running = {
      id: JOB,
      caseRel: 'cases/c1',
      app: 'pimpleFoam',
      nProcs: 1,
      status: 'running',
      stage: 'solve',
      stopping: false,
      ahead: null,
      createdAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      code: null,
      result: null,
      seq: 5,
    };
    // The study's case, as the app would list it and say where it is.
    await page.route(/\/api\/plugin-cases\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, jobs: [running] }) }));
    await page.route(/\/api\/plugin-cases\/status\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, job: running }) }));
    const emit = async (seq, ev) => {
      const r = await request.post(`${host.base}/api/test/plugin-case-event`, { data: { ...scope, job_id: JOB, seq, ev } });
      expect(r.ok(), await r.text()).toBe(true);
    };
    const seen = watchRequests(page.context());
    await page.goto(`${host.base}/#/p/${pj.id}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pj.id, { timeout: 60_000 });
    await page.evaluate((h) => {
      window.location.hash = h;
    }, `#/p/${pj.id}/ws/foam-demo/cavity/${sj.study.id}`);
    const frame = page.frameLocator('#workspace-frame');
    // The page found its running case and follows it.
    await expect(frame.locator('#status')).toHaveText('running', { timeout: 60_000 });
    await expect(frame.locator('#events')).toContainText('{"event":"start"}');
    const tab = seen.tabIdOf(page);
    expect(tab, "the tab's event stream").toBeTruthy();
    await expect.poll(async () => ((await serverStream(request, host, tab)) || { kinds: {} }).kinds.case || 0, { timeout: 15_000 }).toBe(1);

    // The user leaves the tab while the case runs: its stream stays.
    await setHidden(page, true);
    await page.waitForTimeout(6_000);
    const kept = await serverStream(request, host, tab);
    expect(kept, 'a hidden tab whose page follows a running case keeps its stream').not.toBeNull();
    // The case goes on meanwhile: its page hears every event.
    for (let i = 1; i <= 3; i++) await emit(5 + i, { event: 'progress', time: i, n_steps: i, residuals: {}, points: [{ t: i }] });
    await emit(9, { event: 'time_saved', t: 3 });
    await expect(frame.locator('#events')).toContainText('{"event":"time_saved","t":3}', { timeout: 15_000 });
    const lines = (await frame.locator('#events').textContent()).trim().split('\n').map((l) => JSON.parse(l));
    stage(`hidden 6 s and more: the server carries ${kept.channels} channel(s) for the tab; the page heard ${lines.map((l) => l.event).join(', ')}`);
    expect(lines.filter((l) => l.event === 'progress').map((l) => l.points[0].t), 'every point, while the tab was hidden').toEqual([1, 2, 3]);
    await setHidden(page, false);

    // The case ends; hidden again, the tab lets its stream go (nothing to keep it for).
    await emit(10, { event: 'end', status: 'done', error: null, code: null, result: { saved_times: [3], last_saved: 3, phases: {}, write_format: 'binary' } });
    await expect(frame.locator('#status')).toHaveText('done', { timeout: 15_000 });
    await setHidden(page, true);
    await expect
      .poll(() => serverStream(request, host, tab), { timeout: 15_000, message: 'the case has ended: the hidden tab lets its stream go' })
      .toBeNull();
  });
});
