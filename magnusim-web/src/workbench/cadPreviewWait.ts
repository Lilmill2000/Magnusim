/**
 * A part's preview (GET /api/geometry/cad), asked for until it is made.
 *
 * A preview that is not made yet (a plain STEP part whose cad_faces.vtp, cad_edges.vtp and
 * cad_preview.json are missing or older than its file) takes seconds to minutes to make. The
 * server used to hold each request for the whole build, and the browser opens at most 6
 * connections to the app for all of its tabs: the viewport's four requests for one part, in
 * two tabs, froze every tab. Now the server answers 202 {pending} with Retry-After after a
 * quarter of a second, and the page asks again, one request at a time, until it is made (200)
 * or fails (any other status, returned as it is). A 202 is `r.ok`: only a 200 is the preview.
 * A preview made is shown at most 2 s after it is (the asks are a second apart, then 1.5 s,
 * then 2 s: each holds a connection a quarter of a second at most).
 */

/**
 * The answer: its status and body (the parsed JSON), and `active` when the server says whether
 * the geometry is the project's active one (X-CFD-Active-Geometry); or superseded.
 */
export type CadPreviewAnswer = { superseded?: false; status: number; body: unknown; active?: boolean } | { superseded: true };

export interface CadPreviewWaitOpts {
  /** False once the caller no longer wants this preview (another part, another project). */
  isCurrent?: () => boolean;
  /** The preview is being made: called once, at the first "being prepared". */
  onPending?: () => void;
}

/** The longest wait between two asks: a part made is on screen this soon after. */
const MAX_WAIT_MS = 2000;
/** How often a wait checks that the preview is still wanted. */
const CHECK_MS = 100;

function retryAfterMs(r: Response): number {
  const s = Number(r.headers.get('Retry-After'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : 1000;
}

/** Wait `ms`, or less once the caller no longer wants the preview. */
async function pause(ms: number, isCurrent: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (isCurrent()) {
    const left = until - Date.now();
    if (left <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(CHECK_MS, left)));
  }
}

/**
 * GET `url` until the preview is made: { status: 200, body } then (the parsed JSON for
 * part=preview), { status, body } for any other answer but 202, or { superseded: true } once
 * `isCurrent` turns false. Each wait is the server's Retry-After (1 s without one), longer
 * by half each time, at most 2 s.
 */
export async function waitCadPreview(url: string, opts: CadPreviewWaitOpts = {}): Promise<CadPreviewAnswer> {
  const isCurrent = opts.isCurrent || (() => true);
  let told = false;
  let wait = 0;
  for (;;) {
    if (!isCurrent()) return { superseded: true };
    // The server marks every answer no-store (a 200 too), so the browser never kept one;
    // asking no-store also keeps two tabs' asks for the same URL off the browser's cache lock.
    const r = await fetch(url, { cache: 'no-store' });
    if (!isCurrent()) return { superseded: true };
    if (r.status !== 202) {
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      const active = r.headers.get('X-CFD-Active-Geometry');
      return active == null ? { status: r.status, body } : { status: r.status, body, active: active === '1' };
    }
    await r.text().catch(() => '');
    if (!told) {
      told = true;
      try {
        opts.onPending?.();
      } catch (e) {
        console.warn('[CFD] preview pending', e);
      }
    }
    const hinted = retryAfterMs(r);
    wait = Math.min(MAX_WAIT_MS, Math.max(hinted, wait ? wait * 1.5 : hinted));
    await pause(wait, isCurrent);
  }
}
