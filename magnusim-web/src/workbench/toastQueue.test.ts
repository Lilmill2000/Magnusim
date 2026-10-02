import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastQueue, TOAST_FADE_MS, TOAST_READ_MIN_MS } from './toastQueue';

// The toast as shell.html has it.
const SHELL = '<div id="job-finish-toast" class="job-finish-toast" hidden role="status" aria-live="polite"></div>';

/** Every paint of the toast (text and style) and every hide, with the fake clock's time. */
function watch(el: HTMLElement) {
  const log: Array<{ at: number; text?: string; fail?: boolean; hidden?: true }> = [];
  let last = '';
  let wasHidden = el.hidden;
  const look = () => {
    if (el.hidden) {
      if (!wasHidden) log.push({ at: Date.now(), hidden: true });
      wasHidden = true;
      return;
    }
    const text = el.textContent || '';
    if (wasHidden || text !== last) log.push({ at: Date.now(), text, fail: el.classList.contains('is-fail') });
    last = text;
    wasHidden = false;
  };
  return { log, look };
}

describe('the job toast shows every toast in turn', () => {
  let el: HTMLElement;
  let frames: Array<() => void>;
  let q: ReturnType<typeof createToastQueue>;
  let w: ReturnType<typeof watch>;
  const t0 = Date.UTC(2026, 9, 2, 12);
  /** Advance the clock in 10 ms steps, looking at the toast after each (as a painted frame would). */
  const run = (ms: number) => {
    for (let i = 0; i < ms; i += 10) {
      vi.advanceTimersByTime(10);
      frames.splice(0).forEach((f) => f());
      w.look();
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    document.body.innerHTML = SHELL;
    el = document.getElementById('job-finish-toast') as HTMLElement;
    frames = [];
    q = createToastQueue({ el: () => document.getElementById('job-finish-toast'), frame: (f) => frames.push(f) });
    w = watch(el);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('paints two notices of one poll one after the other, each readable, the last for its own 9 s', () => {
    q.push({ text: 'Run A could not start from the queue: x.', fail: true, ms: 9000 });
    q.push({ text: 'Run B could not start from the queue: y.', fail: true, ms: 9000 });
    w.look();
    run(20_000);
    expect(w.log).toEqual([
      { at: t0, text: 'Run A could not start from the queue: x.', fail: true },
      { at: t0 + TOAST_READ_MIN_MS + TOAST_FADE_MS, text: 'Run B could not start from the queue: y.', fail: true },
      { at: t0 + TOAST_READ_MIN_MS + 2 * TOAST_FADE_MS + 9000, hidden: true },
    ]);
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });

  it('keeps each toast its own time when nothing waits: 3.8 s for a finish, 9 s for a notice', () => {
    q.push({ text: 'Run 1 finished simulating.', fail: false, ms: 3800 });
    w.look();
    run(10_000);
    q.push({ text: 'Run 2 could not start from the queue: x.', fail: true, ms: 9000 });
    w.look();
    run(10_000);
    expect(w.log).toEqual([
      { at: t0, text: 'Run 1 finished simulating.', fail: false },
      { at: t0 + 3800 + TOAST_FADE_MS, hidden: true },
      { at: t0 + 10_000, text: 'Run 2 could not start from the queue: x.', fail: true },
      { at: t0 + 10_000 + 9000 + TOAST_FADE_MS, hidden: true },
    ]);
  });

  it('a run-finished toast never hides a notice on screen: it waits for the readable minimum', () => {
    q.push({ text: 'Case c4 was taken off the queue: x.', fail: true, ms: 9000 });
    w.look();
    run(1000);
    q.push({ text: 'Run 1 finished simulating.', fail: false, ms: 3800 });
    w.look();
    run(10_000);
    expect(w.log).toEqual([
      { at: t0, text: 'Case c4 was taken off the queue: x.', fail: true },
      // Shortened from 9 s because a toast waits, but never below the minimum; not a failure: no is-fail.
      { at: t0 + TOAST_READ_MIN_MS + TOAST_FADE_MS, text: 'Run 1 finished simulating.', fail: false },
      { at: t0 + TOAST_READ_MIN_MS + 2 * TOAST_FADE_MS + 3800, hidden: true },
    ]);
    expect(el.classList.contains('is-fail')).toBe(false);
  });

  it('a notice never hides a run-finished toast on screen, and a toast already read gives way at once', () => {
    q.push({ text: 'Run 1 solve stopped.', fail: false, ms: 3800 });
    w.look();
    run(500);
    q.push({ text: 'Run 2 could not start from the queue: x.', fail: true, ms: 9000 });
    w.look();
    run(TOAST_READ_MIN_MS + 2 * TOAST_FADE_MS);
    expect(w.log).toEqual([
      { at: t0, text: 'Run 1 solve stopped.', fail: false },
      { at: t0 + TOAST_READ_MIN_MS + TOAST_FADE_MS, text: 'Run 2 could not start from the queue: x.', fail: true },
    ]);
    // Run 2 has been on screen for longer than the minimum: a third toast follows right after its fade.
    run(4000);
    const third = Date.now();
    q.push({ text: 'Run 3 finished simulating.', fail: false, ms: 3800 });
    w.look();
    run(1000);
    expect(w.log.slice(2)).toEqual([{ at: third + TOAST_FADE_MS, text: 'Run 3 finished simulating.', fail: false }]);
  });

  it('fades the toast out before the next one, and a toast that arrives during the fade waits for the whole fade', () => {
    q.push({ text: 'Run 1 finished simulating.', fail: false, ms: 3800 });
    frames.splice(0).forEach((f) => f());
    expect(el.classList.contains('is-on')).toBe(true);
    run(3800);
    expect(el.classList.contains('is-on')).toBe(false);
    expect(el.hidden).toBe(false);
    q.push({ text: 'Run 2 could not start from the queue: x.', fail: true, ms: 9000 });
    // The fade is not cut short: the old text stays, fading, to the end of the fade.
    run(TOAST_FADE_MS - 20);
    expect(el.textContent).toBe('Run 1 finished simulating.');
    expect(el.classList.contains('is-on')).toBe(false);
    expect(q.showing()).toBe('Run 1 finished simulating.');
    run(20);
    expect(el.textContent).toBe('Run 2 could not start from the queue: x.');
    expect(el.hidden).toBe(false);
    frames.splice(0).forEach((f) => f());
    expect(el.classList.contains('is-on')).toBe(true);
    expect(q.showing()).toBe('Run 2 could not start from the queue: x.');
  });

  it('shows many notices in arrival order, none twice, and is quiet with no toast element', () => {
    const texts = Array.from({ length: 5 }, (_, i) => `Case c${i + 1} was taken off the queue: x.`);
    texts.forEach((text) => q.push({ text, fail: true, ms: 9000 }));
    expect(q.waiting()).toBe(4);
    w.look();
    run(40_000);
    expect(w.log.filter((e) => !e.hidden).map((e) => e.text)).toEqual(texts);
    expect(w.log.at(-1)?.hidden).toBe(true);
    document.body.innerHTML = '';
    expect(() => q.push({ text: 'Run 9 finished simulating.', fail: false, ms: 3800 })).not.toThrow();
    expect(q.showing()).toBe('');
  });

  it('keeps the readable minimum at 3 s, and the fade as long as the stylesheet transition', () => {
    expect(TOAST_READ_MIN_MS).toBe(3000);
    expect(TOAST_FADE_MS).toBe(280);
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
    const block = css.match(/\.job-finish-toast \{[^}]*\}/)?.[0] || '';
    expect(block).toMatch(/transition: opacity 0\.28s/);
  });

  it.each([
    ['back', -10 * 60_000],
    ['forward', 10 * 60_000],
  ])('times each toast by a steady clock: the wall clock set %s neither holds nor cuts one', (_, jump) => {
    q.push({ text: 'Case c4 was taken off the queue: x.', fail: true, ms: 9000 });
    run(1000);
    vi.setSystemTime(Date.now() + jump);
    q.push({ text: 'Run 1 finished simulating.', fail: false, ms: 3800 });
    // Still the notice, on screen, just before its readable minimum ends...
    run(3000 - 1000 - 20);
    expect(q.showing()).toBe('Case c4 was taken off the queue: x.');
    expect(el.classList.contains('is-on')).toBe(true);
    // ...then the finish toast, right after the fade.
    run(20 + TOAST_FADE_MS);
    expect(q.showing()).toBe('Run 1 finished simulating.');
    expect(el.textContent).toBe('Run 1 finished simulating.');
  });

  it("turns each toast on with the browser's own frame, so it can be seen", () => {
    const own = createToastQueue({ el: () => document.getElementById('job-finish-toast') });
    own.push({ text: 'Run A could not start from the queue: x.', fail: true, ms: 9000 });
    own.push({ text: 'Run 1 finished simulating.', fail: false, ms: 3800 });
    expect(el.classList.contains('is-on')).toBe(false);
    vi.advanceTimersByTime(50);
    expect([el.textContent, el.classList.contains('is-on')]).toEqual(['Run A could not start from the queue: x.', true]);
    vi.advanceTimersByTime(3000 + TOAST_FADE_MS);
    expect([el.textContent, el.classList.contains('is-on')]).toEqual(['Run 1 finished simulating.', true]);
    vi.advanceTimersByTime(3800);
    expect(el.classList.contains('is-on')).toBe(false);
  });
});

describe('runtime.js shows run-finished toasts and queue notices through one queue', () => {
  const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'runtime.js'), 'utf8').replace(/\r\n/g, '\n');
  const fn = (header: string) => {
    const at = runtime.indexOf(header);
    expect(at, header).toBeGreaterThanOrEqual(0);
    return runtime.slice(at, runtime.indexOf('\n}\n', at) + 2);
  };

  it('declares the queue before both functions and never writes the toast directly', () => {
    const decl = runtime.indexOf("const finishToasts = createToastQueue({ el: () => document.getElementById('job-finish-toast') });");
    expect(decl).toBeGreaterThan(0);
    expect(decl).toBeLessThan(runtime.indexOf('function showJobFinishToast('));
    expect(decl).toBeLessThan(runtime.indexOf('function noticeQueueFailures('));
    const finish = fn('function showJobFinishToast(');
    expect(finish).toContain('finishToasts.push({ text, fail: failed, ms: 3800 });');
    expect(finish).toContain('if (key === lastFinishToastKey && Date.now() - lastFinishToastAt < 8000) return;');
    const notices = fn('function noticeQueueFailures(');
    expect(notices).toContain('finishToasts.push({ text: msg, fail: true, ms: 9000 });');
    expect(notices).toContain('jobQueue.seenFailures.add(f.id);');
    // Nothing else paints or times the toast.
    expect(runtime.split("getElementById('job-finish-toast')").length - 1).toBe(2);
    for (const body of [finish, notices]) {
      expect(body).not.toMatch(/\.textContent\s*=|classList|setTimeout|\.hidden\s*=/);
    }
  });
});
