import { expect, test } from '@playwright/test';
import { startHost } from './support/host-server.mjs';

// H15 core bug 1, as the user meets it: a job that sends events as fast as a small
// solver case does (about ten a time step, thousands of steps a second) kept the
// app server from answering until it ended: every request timed out and the
// page's polls stalled. Each event was one file write in the job's log
// (scripts/log.js, through spawnJob) and one whole write of its job file
// (scripts/server/jobs.ts). With such a job running: the API answers at once,
// the job's steps keep moving, the workbench reloads and its own queue poll is
// answered. A second app server with the flood fixture plugin
// (python/tests/fixtures/flood-plugins: a plugin job, no WSL).
const PROJECT = 'sample-project-steady-state-e2e';

test('a job that floods events leaves the app answering', async ({ page, request }) => {
  test.setTimeout(300_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[flood +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const host = await startHost({ name: 'flood', pluginsFrom: 'python/tests/fixtures/flood-plugins' });
  const { base } = host;
  try {
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 120_000 });
    stage('workbench open');

    // 240,000 steps at 2,000 a second: about 19,000 events a second for 2 minutes.
    const started = await request.post(`${base}/api/jobs`, {
      data: { kind: 'flood_demo_events', params: { project_id: PROJECT, steps: 240000, rate: 2000 } },
    });
    expect(started.status(), await started.text()).toBe(202);
    const jobId = (await started.json()).job.id;
    const jobUrl = `${base}/api/jobs/${jobId}?project_id=${PROJECT}`;
    /** A GET and how long it took (the bug: no answer until the job ended). */
    const timed = async (url) => {
      const t = Date.now();
      const r = await request.get(url, { timeout: 10_000 });
      const ms = Date.now() - t;
      expect(r.ok(), url).toBe(true);
      return { ms, body: await r.json() };
    };
    const stepOf = (job) =>
      Math.max(0, ...((job && job.events) || []).filter((e) => e && e.event === 'progress').map((e) => Number(e.step) || 0));

    // It floods: its steps reach the server.
    await expect.poll(async () => stepOf((await timed(jobUrl)).body.job), { timeout: 30_000 }).toBeGreaterThan(2000);
    stage('the job floods');

    // The API answers at once, and the job's steps keep moving.
    const probes = [];
    for (let i = 0; i < 5; i++) {
      const queue = await timed(`${base}/api/compute-queue?project_id=${PROJECT}`);
      const job = await timed(jobUrl);
      probes.push({ queue: queue.ms, job: job.ms, step: stepOf(job.body.job), status: job.body.job.status });
      await new Promise((r) => setTimeout(r, 1000));
    }
    stage(`probes ${JSON.stringify(probes)}`);
    for (const p of probes) {
      expect(p.status).toBe('running');
      expect(p.queue, 'GET /api/compute-queue while the job floods').toBeLessThan(2000);
      expect(p.job, 'GET /api/jobs/<id> while the job floods').toBeLessThan(2000);
    }
    for (let i = 1; i < probes.length; i++) expect(probes[i].step).toBeGreaterThan(probes[i - 1].step);

    // The workbench reloads, and the page's own queue poll (on load, then every
    // 10 s) is answered, all while the job floods.
    const polls = [];
    page.on('requestfinished', (req) => {
      if (req.url().includes('/api/compute-queue')) polls.push(Math.round(req.timing().responseEnd));
    });
    const tReload = Date.now();
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    stage(`reloaded in ${Date.now() - tReload} ms`);
    await expect.poll(() => polls.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    stage(`page queue polls answered in ${JSON.stringify(polls)} ms`);
    for (const ms of polls) expect(ms, "the page's queue poll while the job floods").toBeLessThan(2000);
    const still = await timed(jobUrl);
    expect(still.body.job.status, 'the job was still flooding').toBe('running');
    expect(stepOf(still.body.job)).toBeGreaterThan(probes[probes.length - 1].step);

    // Stop answers too, and ends it.
    const stopped = await request.post(`${base}/api/jobs/${jobId}/stop?project_id=${PROJECT}`, { timeout: 10_000 });
    expect(stopped.ok()).toBe(true);
    await expect.poll(async () => (await timed(jobUrl)).body.job.status, { timeout: 15_000 }).toBe('stopped');
    stage('stopped');
  } finally {
    host.stop();
  }
});
