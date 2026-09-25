import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SciNumberInput, formatSci, parseSci } from './SciNumberInput';

describe('formatSci', () => {
  afterEach(() => cleanup());

  it('shows tiny magnitudes in scientific notation', () => {
    expect(formatSci(1.529e-5)).toBe('1.5290e-5');
    expect(formatSci(1e-6)).toBe('1.0000e-6');
  });

  it('leaves readable magnitudes alone', () => {
    expect(formatSci(0.7)).toBe('0.7');
    expect(formatSci(998.2)).toBe('998.2');
    expect(formatSci(0)).toBe('0');
  });

  it('shows huge magnitudes in scientific notation', () => {
    expect(formatSci(677353000)).toBe('6.7735e+8');
  });

  it('is empty for missing values', () => {
    expect(formatSci(null)).toBe('');
    expect(formatSci(Number.NaN)).toBe('');
  });
});

describe('parseSci', () => {
  it('accepts both notations', () => {
    expect(parseSci('1.5e-5')).toBe(1.5e-5);
    expect(parseSci('0.00002')).toBe(0.00002);
  });

  it('rejects partial input', () => {
    expect(parseSci('1.5e-')).toBeNull();
    expect(parseSci('')).toBeNull();
  });
});

describe('SciNumberInput', () => {
  afterEach(() => cleanup());

  it('renders the formatted value and commits a typed one on blur', () => {
    const onCommit = vi.fn();
    render(<SciNumberInput value={1.529e-5} label="Kinematic viscosity" onCommit={onCommit} />);
    const input = screen.getByLabelText('Kinematic viscosity') as HTMLInputElement;
    expect(input.value).toBe('1.5290e-5');
    fireEvent.change(input, { target: { value: '2e-5' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(0.00002);
    expect(input.value).toBe('2.0000e-5');
  });

  it('does not commit half-typed input', () => {
    const onCommit = vi.fn();
    render(<SciNumberInput value={1e-6} label="Residual" onCommit={onCommit} />);
    const input = screen.getByLabelText('Residual') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.5e-' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('1.0000e-6');
  });

  it('reports every parseable keystroke when onLive is given', () => {
    const onLive = vi.fn();
    render(<SciNumberInput value={5} label="End time" onCommit={() => {}} onLive={onLive} />);
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '7' } });
    expect(onLive).toHaveBeenCalledWith(7);
  });
});
