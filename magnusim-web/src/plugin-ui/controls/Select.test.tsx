import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const OPTIONS = [
  { value: 'Pa', label: 'Pa' },
  { value: 'kPa', label: 'kPa' },
  { value: 'psi', label: 'psi (imperial)', disabled: true },
];

describe('Select', () => {
  it('draws the core panel select, labelled, with kit options', () => {
    render(<Select label="Pressure unit" value="Pa" options={OPTIONS} onChange={() => {}} />);
    const select = screen.getByLabelText('Pressure unit') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.className).toBe('mgk-select');
    expect(select.value).toBe('Pa');
    const options = [...select.querySelectorAll('option')];
    expect(options.map((o) => [o.value, o.textContent, o.className])).toEqual([
      ['Pa', 'Pa', 'mgk-option'],
      ['kPa', 'kPa', 'mgk-option'],
      ['psi', 'psi (imperial)', 'mgk-option'],
    ]);
  });

  it('gives onChange the picked value', () => {
    const onChange = vi.fn();
    render(<Select label="Unit" value="Pa" options={OPTIONS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
    expect(onChange).toHaveBeenCalledWith('kPa');
  });

  it('disables single options and the whole select', () => {
    render(
      <>
        <Select label="One" value="Pa" options={OPTIONS} onChange={() => {}} />
        <Select label="Two" value="Pa" options={OPTIONS} onChange={() => {}} disabled id="two" />
      </>,
    );
    const one = screen.getByLabelText('One') as HTMLSelectElement;
    expect([...one.options].map((o) => o.disabled)).toEqual([false, false, true]);
    expect(one).not.toBeDisabled();
    expect(screen.getByLabelText('Two')).toBeDisabled();
    expect(screen.getByLabelText('Two')).toHaveAttribute('id', 'two');
  });

  it('fill takes a schema form width', () => {
    render(<Select label="Fill" value="Pa" options={OPTIONS} onChange={() => {}} width="fill" />);
    expect(screen.getByLabelText('Fill').className).toBe('mgk-select mgk-select--fill');
  });
});
