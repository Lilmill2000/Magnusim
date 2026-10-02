import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Field } from './Field';

describe('Field', () => {
  it('draws the schema form row: label on the left, the control on the right', () => {
    const { container } = render(
      <Field label="Fineness" htmlFor="fin">
        <input id="fin" />
      </Field>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('mgk-type mgk-field');
    const k = root.children[0] as HTMLElement;
    const v = root.children[1] as HTMLElement;
    expect(k.className).toBe('mgk-field-k');
    expect(k).not.toHaveAttribute('data-help');
    expect(v.className).toBe('mgk-field-v');
    expect(k.querySelector('label')).toHaveAttribute('for', 'fin');
    expect(screen.getByLabelText('Fineness')).toBe(v.querySelector('input'));
    expect(root.querySelector('.mgk-field-help')).toBeNull();
  });

  it('help adds a focusable "?" described by its tip', () => {
    const { container } = render(
      <Field label="Residual p" htmlFor="rp" help="Convergence target for the pressure equation.">
        1e-6
      </Field>,
    );
    expect(container.querySelector('.mgk-field-k')).toHaveAttribute('data-help', '1');
    const help = screen.getByRole('button', { name: 'About Residual p' });
    expect(help.className).toBe('mgk-field-help');
    expect(help).toHaveAttribute('tabindex', '0');
    expect(help).toHaveTextContent('?');
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip.className).toBe('mgk-field-tip');
    expect(tip).toHaveTextContent('Convergence target for the pressure equation.');
    expect(tip.id).toBe('rp__help');
    expect(help).toHaveAttribute('aria-describedby', 'rp__help');
  });

  it('keeps a stable tip id, and its hooks, when htmlFor goes away', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(
        <Field label="A" htmlFor="a" help="Help.">
          x
        </Field>,
      );
      expect(screen.getByRole('tooltip', { hidden: true }).id).toBe('a__help');
      rerender(
        <Field label="A" help="Help.">
          x
        </Field>,
      );
      const first = screen.getByRole('tooltip', { hidden: true }).id;
      expect(first).toMatch(/__help$/);
      expect(first).not.toBe('a__help');
      rerender(
        <Field label="A" help="Help.">
          y
        </Field>,
      );
      expect(screen.getByRole('tooltip', { hidden: true }).id).toBe(first);
      expect(screen.getByRole('button', { name: 'About A' })).toHaveAttribute('aria-describedby', first);
      rerender(
        <Field label="A" help="Help." hidden>
          y
        </Field>,
      );
      rerender(
        <Field label="A" help="Help.">
          y
        </Field>,
      );
      expect(screen.getByRole('tooltip', { hidden: true }).id).toBe(first);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('hidden renders nothing', () => {
    const { container } = render(
      <Field label="Gone" hidden>
        x
      </Field>,
    );
    expect(container.innerHTML).toBe('');
  });
});
