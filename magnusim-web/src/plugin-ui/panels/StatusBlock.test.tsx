import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Elapsed, StatusBlock, useElapsed } from './StatusBlock';

describe('StatusBlock', () => {
  it('draws its parts in the order of the Run panel: title, line, elapsed, ETA, children, meta', () => {
    const { container } = render(
      <StatusBlock title="Running" status="running" line="Iteration 120" elapsed="0:42" eta="~1:10 left" meta={['a', 'b']}>
        <div className="plot">plot</div>
      </StatusBlock>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('mgk-type mgk-status');
    expect(root).toHaveAttribute('data-status', 'running');
    expect([...root.children].map((c) => [c.className, c.textContent])).toEqual([
      ['mgk-status-title', 'Running'],
      ['mgk-status-line', 'Iteration 120'],
      ['mgk-status-elapsed', '0:42'],
      ['mgk-status-eta', '~1:10 left'],
      ['plot', 'plot'],
      ['mgk-status-meta', 'a · b'],
    ]);
  });

  it('joins the meta parts with " · " in one div, and leaves out the parts it was not given', () => {
    const { container } = render(<StatusBlock title="Mesh ready" line="12 cells" meta={['Standard', '3 layers', '0:42']} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toHaveAttribute('data-status');
    expect([...root.children].map((c) => c.className)).toEqual(['mgk-status-title', 'mgk-status-line', 'mgk-status-meta']);
    expect(root.querySelectorAll('.mgk-status-meta')).toHaveLength(1);
    expect(root.querySelector('.mgk-status-meta')).toHaveTextContent('Standard · 3 layers · 0:42');

    const { container: bare } = render(<StatusBlock title="Queued" elapsed="" eta={null} meta={[]} />);
    expect([...(bare.firstElementChild as HTMLElement).children].map((c) => c.className)).toEqual(['mgk-status-title']);
  });
});

describe('useElapsed and Elapsed', () => {
  const T0 = new Date('2026-10-01T12:00:00Z').getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks every second from the start', () => {
    const { result } = renderHook(() => useElapsed(T0 - 5_000));
    expect(result.current).toBe('0:05');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe('0:06');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe('1:06');
  });

  it('freezes on finishedAt', () => {
    const { result } = renderHook(() => useElapsed(T0 - 90_000, T0 - 30_000));
    expect(result.current).toBe('1:00');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe('1:00');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows 0:00 before the start', () => {
    const { result, rerender } = renderHook(({ s }: { s?: number }) => useElapsed(s), { initialProps: {} as { s?: number } });
    expect(result.current).toBe('0:00');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe('0:00');
    expect(vi.getTimerCount()).toBe(0);
    // A start a moment from now (another clock): still 0:00, never negative.
    rerender({ s: T0 + 60_000 + 5_000 });
    expect(result.current).toBe('0:00');
  });

  it('shows h:mm:ss past an hour', () => {
    const { result } = renderHook(() => useElapsed(T0 - 3_725_000));
    expect(result.current).toBe('1:02:05');
    const { container } = render(<Elapsed startedAt={T0} finishedAt={T0 + 3_725_000} />);
    expect(container.innerHTML).toBe('<span class="mgk-elapsed">1:02:05</span>');
  });

  it('stops ticking when it unmounts', () => {
    const { unmount } = renderHook(() => useElapsed(T0 - 1000));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
