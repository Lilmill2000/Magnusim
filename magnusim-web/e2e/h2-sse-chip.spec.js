import { expect, test } from '@playwright/test';

const PROJECT_A = 'sample-project-steady-state-e2e';

test('gate:h2-sse-chip mesh progress reaches the viewport chip', async ({ page }) => {
  test.setTimeout(90_000);
  const statusPolls = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/run/status')) statusPolls.push(req.url());
  });
  await page.addInitScript(() => {
    window.__CFD_DISABLE_RUN_STATUS_POLL__ = true;
  });
  await page.route('**/api/jobs/job-h2/events*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
      body: 'event: event\ndata: {"event":"progress","stage":"gmsh","status":"running"}\n\n',
    });
  });
  await page.goto(`/#/p/${encodeURIComponent(PROJECT_A)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__CFD_WATCH_JOB__ === 'function');
  await page.waitForFunction(() => {
    const label = document.getElementById('viewport-job-label');
    return !!label && !String(label.textContent || '').includes('Opening');
  }, null, { timeout: 60_000 });
  await page.evaluate(() => window.__CFD_WATCH_JOB__('job-h2'));
  await expect(page.locator('#viewport-job-label')).toContainText('gmsh', { timeout: 15_000 });
  expect(statusPolls).toEqual([]);
});
