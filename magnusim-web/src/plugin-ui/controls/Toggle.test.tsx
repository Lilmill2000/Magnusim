import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Toggle } from './Toggle';

function Live({ variant }: { variant?: 'switch' | 'pill' }) {
  const [on, setOn] = useState(false);
  return <Toggle label="Layers" checked={on} onChange={setOn} variant={variant} />;
}

describe('Toggle', () => {
  it('the switch is a real checkbox, labelled, inside the kit switch', () => {
    const { container } = render(<Toggle label="Layers" checked={false} onChange={() => {}} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('LABEL');
    expect(root.className).toBe('mgk-type mgk-switch');
    const box = screen.getByRole('checkbox', { name: 'Layers' }) as HTMLInputElement;
    expect(box.tagName).toBe('INPUT');
    expect(box).toHaveAttribute('type', 'checkbox');
    expect(box.className).toBe('mgk-switch-input');
    expect(box.nextElementSibling?.className).toBe('mgk-switch-track');
    expect(box.checked).toBe(false);
  });

  it('the switch toggles on a click', () => {
    render(<Live />);
    const box = screen.getByRole('checkbox', { name: 'Layers' }) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
  });

  it('the pill sets aria-pressed, its text and the kit ON modifier, never is-on', () => {
    render(<Live variant="pill" />);
    const pill = screen.getByRole('button', { name: 'Layers' });
    expect(pill).toHaveAttribute('type', 'button');
    expect(pill).toHaveAttribute('aria-pressed', 'false');
    expect(pill).toHaveTextContent('OFF');
    expect(pill.className).toBe('mgk-pill');
    fireEvent.click(pill);
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    expect(pill).toHaveTextContent('ON');
    expect(pill.className).toBe('mgk-pill mgk-pill--on');
    expect(pill.className).not.toMatch(/\bis-/);
  });

  it('disabled blocks the switch and the pill', () => {
    const onSwitch = vi.fn();
    const onPill = vi.fn();
    render(
      <>
        <Toggle label="S" checked={false} onChange={onSwitch} disabled id="s" />
        <Toggle label="P" checked={false} onChange={onPill} variant="pill" disabled id="p" />
      </>,
    );
    const box = screen.getByRole('checkbox', { name: 'S' });
    const pill = screen.getByRole('button', { name: 'P' });
    expect(box).toBeDisabled();
    expect(pill).toBeDisabled();
    expect(box).toHaveAttribute('id', 's');
    expect(pill).toHaveAttribute('id', 'p');
    fireEvent.click(box);
    fireEvent.click(pill);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onPill).not.toHaveBeenCalled();
  });
});
