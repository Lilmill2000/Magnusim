import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitCadPreview } from './cadPreviewWait';

const pending = (retryAfter: string | null = '1') =>
  new Response(JSON.stringify({ ok: false, pending: true, code: 'preview_pending' }), {
    status: 202,
    headers: retryAfter ? { 'Retry-After': retryAfter } : {},
  });

/** fetch answering each call in turn; the times it was called at (ms since the start). */
function answers(list: Array<() => Response>) {
  const at: number[] = [];
  const t0 = Date.now();
  let inFlight = 0;
  let most = 0;
  const fn = vi.fn(async () => {
    at.push(Date.now() - t0);
    inFlight += 1;
    most = Math.max(most, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    const next = list.shift();
    if (!next) throw new Error('asked once too often');
    return next();
  });
  vi.stubGlobal('fetch', fn);
  return { fn, at, most: () => most };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a preview asked for until it is made', () => {
  it("waits the server's Retry-After, half as long again each time, at most 2 s, one request at a time; a 200 is the preview", async () => {
    const meta = { n_faces: 12, faces: [] };
    const f = answers([() => pending('1'), () => pending('1'), () => pending('1'), () => pending('3'), () => pending('3'), () => new Response(JSON.stringify(meta), { status: 200 })]);
    const onPending = vi.fn();
    const done = waitCadPreview('/api/geometry/cad?project_id=p1&part=preview', { onPending });
    await vi.runAllTimersAsync();
    expect(await done).toEqual({ status: 200, body: meta });
    // 1 s, 1.5 s, then 2 s at most (a part made is on screen at most 2 s after), however
    // long the server asks to wait.
    const gaps = f.at.slice(1).map((t, i) => t - f.at[i]);
    expect(gaps).toEqual([1000, 1500, 2000, 2000, 2000]);
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(f.most()).toBe(1);
    expect(f.fn.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
  });

  it('no Retry-After waits 1 s; a longer one than 2 s waits 2 s', async () => {
    const f = answers([() => pending(null), () => pending('4'), () => new Response('{}', { status: 200 })]);
    const done = waitCadPreview('/x');
    await vi.runAllTimersAsync();
    await done;
    expect(f.at.slice(1).map((t, i) => t - f.at[i])).toEqual([1000, 2000]);
  });

  it("says whether the server answered the project's active geometry", async () => {
    answers([
      () => new Response('{"n_faces":3}', { status: 200, headers: { 'X-CFD-Active-Geometry': '1' } }),
      () => new Response('{"n_faces":4}', { status: 200, headers: { 'X-CFD-Active-Geometry': '0' } }),
    ]);
    expect(await waitCadPreview('/x')).toEqual({ status: 200, body: { n_faces: 3 }, active: true });
    expect(await waitCadPreview('/x')).toEqual({ status: 200, body: { n_faces: 4 }, active: false });
  });

  it('stops once the preview is no longer wanted: superseded, and nothing more is asked', async () => {
    let current = true;
    const f = answers([() => pending('2'), () => pending('2'), () => pending('2')]);
    const onPending = vi.fn();
    const done = waitCadPreview('/x', { isCurrent: () => current, onPending });
    await vi.advanceTimersByTimeAsync(500);
    current = false;
    await vi.runAllTimersAsync();
    expect(await done).toEqual({ superseded: true });
    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(onPending).toHaveBeenCalledTimes(1);
  });

  it('a failure (500) is returned as it is, not asked again', async () => {
    const f = answers([() => pending('1'), () => new Response(JSON.stringify({ error: 'CAD preview failed' }), { status: 500 })]);
    const done = waitCadPreview('/x');
    await vi.runAllTimersAsync();
    expect(await done).toEqual({ status: 500, body: { error: 'CAD preview failed' } });
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('a preview made already is one request, with no pending call', async () => {
    const onPending = vi.fn();
    const f = answers([() => new Response('{"n_faces":3}', { status: 200 })]);
    expect(await waitCadPreview('/x', { onPending })).toEqual({ status: 200, body: { n_faces: 3 } });
    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(onPending).not.toHaveBeenCalled();
  });
});
