import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast, type ToastKind } from './Toast';

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is info by default, and closes after 3.8 s', () => {
    const onClose = vi.fn();
    render(<Toast message="Saved" onClose={onClose} />);
    const toast = screen.getByRole('status');
    expect(toast.className).toBe('mgk-type mgk-toast mgk-toast--info');
    expect(toast.querySelector('.mgk-toast-msg')).toHaveTextContent('Saved');
    advance(3799);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a success closes after 3.8 s, an error after 9 s', () => {
    const success = vi.fn();
    const error = vi.fn();
    render(<Toast message="Saved" kind="success" onClose={success} />);
    render(<Toast message="Failed" kind="error" onClose={error} />);
    advance(3800);
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    advance(5199);
    expect(error).not.toHaveBeenCalled();
    advance(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('gives each kind its kit modifier and never an is-* class', () => {
    const kinds: ToastKind[] = ['info', 'success', 'error'];
    for (const kind of kinds) {
      const { container, unmount } = render(<Toast message={kind} kind={kind} onClose={() => undefined} />);
      const root = container.firstElementChild as HTMLElement;
      expect(root.className).toBe(`mgk-type mgk-toast mgk-toast--${kind}`);
      expect([...root.classList].filter((c) => c.startsWith('is-'))).toEqual([]);
      unmount();
    }
    // A kind a plain-JS caller made up is info.
    const { container } = render(<Toast message="odd" kind={'warning' as ToastKind} onClose={() => undefined} />);
    expect((container.firstElementChild as HTMLElement).className).toBe('mgk-type mgk-toast mgk-toast--info');
  });

  it('a duration of 0 never closes by itself', () => {
    const onClose = vi.fn();
    render(<Toast message="Kept" kind="error" durationMs={0} onClose={onClose} />);
    advance(60_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses while the pointer is over it, and leaving starts the full duration again', () => {
    const onClose = vi.fn();
    render(<Toast message="Saved" onClose={onClose} />);
    const toast = screen.getByRole('status');
    advance(3000);
    fireEvent.mouseEnter(toast);
    advance(10_000);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    advance(3799);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pauses while the focus is inside it, and leaving starts the full duration again', () => {
    const onClose = vi.fn();
    render(
      <>
        <Toast message="Saved" onClose={onClose} />
        <button type="button">elsewhere</button>
      </>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    advance(3000);
    act(() => close.focus());
    advance(10_000);
    expect(onClose).not.toHaveBeenCalled();
    act(() => screen.getByRole('button', { name: 'elsewhere' }).focus());
    advance(3799);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('paused holds it like hover, and letting go starts the full duration again', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Toast message="Saved" onClose={onClose} />);
    advance(3000);
    rerender(<Toast message="Saved" onClose={onClose} paused />);
    advance(10_000);
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Toast message="Saved" onClose={onClose} paused={false} />);
    advance(3799);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('× calls onClose', () => {
    const onClose = vi.fn();
    render(<Toast message="Saved" durationMs={0} onClose={onClose} />);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveAttribute('type', 'button');
    expect(close.className).toBe('mgk-toast-close');
    expect(close).toHaveTextContent('×');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a re-render with a new onClose does not restart the time, and calls the new one', () => {
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = render(<Toast message="Saved" onClose={a} />);
    advance(3000);
    rerender(<Toast message="Saved" onClose={b} />);
    advance(800);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it('spreads attrs on its root', () => {
    render(<Toast message="Saved" durationMs={0} onClose={() => undefined} attrs={{ 'data-ws-toast': '1' }} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-ws-toast', '1');
  });
});
