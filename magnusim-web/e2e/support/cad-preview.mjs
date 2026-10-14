// A geometry's CAD preview (GET /api/geometry/cad) once it is made. A preview that is not
// made yet (a plain STEP part shown for the first time, an old preview made again) is
// answered 202 "being prepared" (Retry-After) while it is made, never held: ask again, as
// the app does (src/workbench/cadPreviewWait.ts). Previews made at import answer at once.
//
//   import { cadPreviewReady } from './support/cad-preview.mjs';
//   const meta = await (await cadPreviewReady(request, `${base}/api/geometry/cad?project_id=${pid}&part=preview`)).json();
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * GET `url` until the answer is not 202 (at most `timeout` ms): that response.
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {string} url
 * @param {number} [timeout]
 */
export async function cadPreviewReady(request, url, timeout = 180_000) {
  const by = Date.now() + timeout;
  for (;;) {
    let r;
    try {
      r = await request.get(url, { timeout: Math.max(1_000, by - Date.now()) });
    } catch (e) {
      // A poll can reuse a keep-alive socket just as the server closes it: ask again.
      if (!/ECONNRESET|socket hang up/i.test(String(e)) || Date.now() > by) throw e;
      continue;
    }
    if (r.status() !== 202) return r;
    if (Date.now() > by) throw new Error(`${url}: still being prepared after ${timeout} ms`);
    const wait = Math.min(5_000, Math.max(250, Number(r.headers()['retry-after']) * 1000 || 1_000));
    await new Promise((done) => setTimeout(done, wait));
  }
}
