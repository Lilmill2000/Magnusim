// A job's events for a page, with no job on the server: the page's one event stream
// (GET /api/events, src/api/eventHub.ts) and its channel calls are answered here. Each
// answer of the stream is a hello and then the frames of the job's channels asked for since
// the last one, each channel's once; the stream then ends and the page opens it again
// (retry 200 ms), and every hello asks for its channels again. A frame reaches its channel
// by its id (`c`), as the server's do.
//
//   import { mockJobChannel } from './support/event-hub-mock.js';
//   await mockJobChannel(page, 'job-h2', () => [['event', { event: 'progress', stage: 'gmsh', status: 'running' }]]);
//
// `frames`: a list of [event, data], or a function giving it when a channel's frames are
// sent (a test that changes them between two follows of the job). Every channel is
// answered ok; only the job's get frames. Call it before the page loads.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} jobId
 * @param {Array<[string, unknown]> | (() => Array<[string, unknown]>)} frames
 */
export async function mockJobChannel(page, jobId, frames) {
  /** Channel ids of the job asked for and not sent their frames yet. */
  const waiting = new Set();
  const sent = new Set();
  let hello = 0;
  await page.route(/\/api\/events\/(subscribe|unsubscribe)(\?|$)/, async (route) => {
    let body = {};
    try {
      body = JSON.parse(route.request().postData() || '{}');
    } catch {
      body = {};
    }
    const channels = Array.isArray(body.channels) ? body.channels : [];
    for (const c of channels) {
      if (c && c.kind === 'job' && c.params && c.params.job_id === jobId && !sent.has(c.cid)) waiting.add(c.cid);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, results: channels.map((c) => ({ cid: c && c.cid, ok: true })) }),
    });
  });
  await page.route(/\/api\/events\?/, async (route) => {
    hello += 1;
    let out = `retry: 200\n\nevent: hello\ndata: ${JSON.stringify({ conn: `mock-${hello}` })}\n\n`;
    const list = typeof frames === 'function' ? frames() : frames;
    for (const cid of waiting) {
      for (const [event, data] of list) out += `event: ${event}\ndata: ${JSON.stringify({ c: cid, d: data })}\n\n`;
      sent.add(cid);
    }
    waiting.clear();
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
      body: out,
    });
  });
}
