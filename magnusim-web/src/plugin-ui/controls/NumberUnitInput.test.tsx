import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NumberUnitInput } from './NumberUnitInput';

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe('NumberUnitInput', () => {
  it('draws the core value row: a decimal text input and its unit', () => {
    const { container } = render(
      <NumberUnitInput label="Gap" valueSi={0.025} quantity="length" onCommitSi={() => {}} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('SPAN');
    expect(root.className).toBe('mgk-type mgk-value-row');
    const el = input('Gap');
    expect(el.className).toBe('mgk-input mgk-input--narrow');
    expect(el).toHaveAttribute('type', 'text');
    expect(el).toHaveAttribute('inputmode', 'decimal');
    expect(el).toHaveAttribute('spellcheck', 'false');
    expect(root.querySelector('span.mgk-unit')).toHaveTextContent('mm');
  });

  it('commits on blur, in SI', () => {
    const onCommitSi = vi.fn();
    render(<NumberUnitInput label="Gap" valueSi={0.025} quantity="length" onCommitSi={onCommitSi} />);
    expect(input('Gap').value).toBe('25');
    fireEvent.change(input('Gap'), { target: { value: '30' } });
    fireEvent.blur(input('Gap'));
    expect(onCommitSi).toHaveBeenCalledTimes(1);
    expect(onCommitSi.mock.calls[0][0]).toBeCloseTo(0.03, 12);
  });

  it('commits on Enter and restores on Escape', () => {
    const onCommitSi = vi.fn();
    render(<NumberUnitInput label="Speed" valueSi={5} quantity="velocity" onCommitSi={onCommitSi} />);
    fireEvent.change(input('Speed'), { target: { value: '7' } });
    fireEvent.keyDown(input('Speed'), { key: 'Enter' });
    expect(onCommitSi).toHaveBeenCalledWith(7);

    fireEvent.change(input('Speed'), { target: { value: '9' } });
    fireEvent.keyDown(input('Speed'), { key: 'Escape' });
    expect(input('Speed').value).toBe('5');
    expect(onCommitSi).toHaveBeenCalledTimes(1);
  });

  it('does not commit an untouched blur or half-typed input', () => {
    const onCommitSi = vi.fn();
    render(<NumberUnitInput label="Nu" valueSi={1.529e-5} quantity="kinematic_viscosity" onCommitSi={onCommitSi} />);
    expect(input('Nu').value).toBe('1.5290e-5');
    fireEvent.focus(input('Nu'));
    fireEvent.blur(input('Nu'));
    fireEvent.change(input('Nu'), { target: { value: '1.5e-' } });
    fireEvent.blur(input('Nu'));
    expect(onCommitSi).not.toHaveBeenCalled();
    expect(input('Nu').value).toBe('1.5290e-5');
  });

  it('reports each keystroke that parses, in SI', () => {
    const onLiveSi = vi.fn();
    render(
      <NumberUnitInput label="Gap" valueSi={0.0254} quantity="length" units="imperial" onCommitSi={() => {}} onLiveSi={onLiveSi} />,
    );
    fireEvent.change(input('Gap'), { target: { value: '2' } });
    fireEvent.change(input('Gap'), { target: { value: '2e' } });
    expect(onLiveSi).toHaveBeenCalledTimes(1);
    expect(onLiveSi.mock.calls[0][0]).toBeCloseTo(0.0508, 12);
  });

  it('shows length in mm (metric) and in (imperial)', () => {
    const { container, rerender } = render(
      <NumberUnitInput label="Gap" valueSi={0.0254} quantity="length" onCommitSi={() => {}} />,
    );
    expect(container.querySelector('.mgk-unit')).toHaveTextContent('mm');
    expect(input('Gap').value).toBe('25.4');
    rerender(<NumberUnitInput label="Gap" valueSi={0.0254} quantity="length" units="imperial" onCommitSi={() => {}} />);
    expect(container.querySelector('.mgk-unit')).toHaveTextContent('in');
    expect(input('Gap').value).toBe('1');
  });

  it('shows pressure in Pa in both systems, as schema forms do', () => {
    const { container, rerender } = render(
      <NumberUnitInput label="p" valueSi={101325} quantity="pressure" onCommitSi={() => {}} />,
    );
    expect(container.querySelector('.mgk-unit')).toHaveTextContent('Pa');
    rerender(<NumberUnitInput label="p" valueSi={101325} quantity="pressure" units="imperial" onCommitSi={() => {}} />);
    expect(container.querySelector('.mgk-unit')).toHaveTextContent('Pa');
    expect(input('p').value).toBe('101325');
  });

  it('shows and commits in an explicit unit', () => {
    const onCommitSi = vi.fn();
    const { container } = render(
      <NumberUnitInput label="p" valueSi={101325} quantity="pressure" unit="psi" onCommitSi={onCommitSi} />,
    );
    expect(container.querySelector('.mgk-unit')).toHaveTextContent('psi');
    expect(input('p').value).toBe('14.6959');
    fireEvent.change(input('p'), { target: { value: '1' } });
    fireEvent.blur(input('p'));
    expect(onCommitSi.mock.calls[0][0]).toBeCloseTo(6894.757293168, 9);
  });

  it('round-trips SI through the shown unit', () => {
    const onCommitSi = vi.fn();
    render(<NumberUnitInput label="T" valueSi={300} quantity="temperature" unit="°C" onCommitSi={onCommitSi} />);
    expect(input('T').value).toBe('26.85');
    fireEvent.change(input('T'), { target: { value: '20' } });
    fireEvent.blur(input('T'));
    expect(onCommitSi.mock.calls[0][0]).toBeCloseTo(293.15, 9);
  });

  it('without a quantity: the plain value and no unit label', () => {
    const onCommitSi = vi.fn();
    const { container } = render(<NumberUnitInput label="Count" valueSi={3} onCommitSi={onCommitSi} />);
    expect(container.querySelector('.mgk-unit')).toBeNull();
    fireEvent.change(input('Count'), { target: { value: '4' } });
    fireEvent.blur(input('Count'));
    expect(onCommitSi).toHaveBeenCalledWith(4);
  });

  it('takes a width, an id and disabled', () => {
    render(
      <>
        <NumberUnitInput label="A" valueSi={1} width="wide" onCommitSi={() => {}} />
        <NumberUnitInput label="B" valueSi={1} width="fill" id="b-field" disabled onCommitSi={() => {}} />
        <NumberUnitInput label="C" valueSi={null} onCommitSi={() => {}} />
      </>,
    );
    expect(input('A').className).toBe('mgk-input mgk-input--wide');
    expect(input('B').className).toBe('mgk-input mgk-input--fill');
    expect(input('B')).toHaveAttribute('id', 'b-field');
    expect(input('B')).toBeDisabled();
    expect(input('C').value).toBe('');
  });
});
