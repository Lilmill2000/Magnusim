import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelError } from './PanelError';

describe('PanelError', () => {
  it('says the panel stopped working by default, with the message, as an alert', () => {
    render(<PanelError message="panel failed" />);
    const card = screen.getByRole('alert');
    expect(card.className).toBe('mgk-type mgk-error');
    expect(card.querySelector('.mgk-error-title')).toHaveTextContent('This panel stopped working.');
    expect(card.querySelector('.mgk-error-msg')).toHaveTextContent('panel failed');
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('takes its own title', () => {
    render(<PanelError title="The Filters section stopped working." message="x" />);
    expect(screen.getByRole('alert').querySelector('.mgk-error-title')).toHaveTextContent('The Filters section stopped working.');
  });

  it('caps the message at 300 characters, ending in an ellipsis', () => {
    render(<PanelError message={'a'.repeat(400)} />);
    const msg = screen.getByRole('alert').querySelector('.mgk-error-msg') as HTMLElement;
    expect(msg.textContent).toHaveLength(300);
    expect(msg.textContent?.endsWith('…')).toBe(true);
    expect(msg.textContent?.slice(0, 299)).toBe('a'.repeat(299));
  });

  it('keeps a message of 300 characters whole', () => {
    render(<PanelError message={'b'.repeat(300)} />);
    expect(screen.getByRole('alert').querySelector('.mgk-error-msg')?.textContent).toBe('b'.repeat(300));
  });

  it('shows Try again only with onRetry', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<PanelError message="x" />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    rerender(<PanelError message="x" onRetry={onRetry} />);
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry.className).toBe('mgk-btn mgk-btn--fix');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the foot with Done only with onDone', () => {
    const onDone = vi.fn();
    const { rerender } = render(<PanelError message="x" />);
    expect(screen.getByRole('alert').querySelector('.mgk-panel-foot')).toBeNull();
    rerender(<PanelError message="x" onDone={onDone} />);
    const foot = screen.getByRole('alert').querySelector('.mgk-panel-foot') as HTMLElement;
    expect([...foot.children].map((c) => c.className)).toEqual(['mgk-panel-foot-left', 'mgk-btn mgk-btn--neutral mgk-panel-done']);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('spreads attrs on its root', () => {
    render(<PanelError message="x" attrs={{ 'data-panel-boundary': '1' }} />);
    expect(screen.getByRole('alert')).toHaveAttribute('data-panel-boundary', '1');
  });
});
