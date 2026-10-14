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
 */

export type CadPreviewAnswer = { superseded?: false; status: number; body: unknown } | { superseded: true };

export interface CadPreviewWaitOpts {
  /** False once the caller no longer wants this preview (another part, another project). */
  isCurrent?: () => boolean;
  /** The preview is being made: called once, at the first "being prepared". */
  onPending?: () => void;
}

/** The longest wait between two asks. */
const MAX_WAIT_MS = 5000;
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
 * by half each time, at most 5 s.
 */
export async function waitCadPreview(url: string, opts: CadPreviewWaitOpts = {}): Promise<CadPreviewAnswer> {
  const isCurrent = opts.isCurrent || (() => true);
  let told = false;
  let wait = 0;
  for (;;) {
    if (!isCurrent()) return { superseded: true };
    const r = await fetch(url, { cache: 'no-store' });
    if (!isCurrent()) return { superseded: true };
    if (r.status !== 202) {
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      return { status: r.status, body };
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
