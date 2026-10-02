import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, type ButtonVariant } from './Button';

describe('Button', () => {
  it('has the kit class and a class per variant; secondary by default', () => {
    const variants: ButtonVariant[] = ['primary', 'secondary', 'neutral', 'link', 'fix', 'danger'];
    for (const variant of variants) {
      render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByRole('button', { name: variant }).className).toBe(`mgk-btn mgk-btn--${variant}`);
    }
    render(<Button>plain</Button>);
    expect(screen.getByRole('button', { name: 'plain' }).className).toBe('mgk-btn mgk-btn--secondary');
  });

  it('is type="button" unless it says submit', () => {
    render(<Button>a</Button>);
    render(<Button type="submit">b</Button>);
    expect(screen.getByRole('button', { name: 'a' })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: 'b' })).toHaveAttribute('type', 'submit');
  });

  it('calls onClick, and a disabled button does not', () => {
    const onClick = vi.fn();
    const off = vi.fn();
    render(<Button onClick={onClick}>go</Button>);
    render(
      <Button onClick={off} disabled>
        stop
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'stop' })).toBeDisabled();
  });

  it('spreads attrs, adds block, appends className, sets title and aria-label', () => {
    render(
      <Button variant="neutral" block className="mgk-panel-done" title="Close" ariaLabel="Done here" attrs={{ 'data-kit-button': '1' }}>
        Done
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Done here' });
    expect(btn.className).toBe('mgk-btn mgk-btn--neutral mgk-btn--block mgk-panel-done');
    expect(btn).toHaveAttribute('data-kit-button', '1');
    expect(btn).toHaveAttribute('title', 'Close');
    expect(btn).toHaveTextContent('Done');
  });
});
