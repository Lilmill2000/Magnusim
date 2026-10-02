import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DisabledReason, EmptyState, Hint } from './Hint';

describe('Hint', () => {
  it('is a muted p by default, with a class per tone', () => {
    const { container } = render(
      <>
        <Hint>muted</Hint>
        <Hint tone="warning">warning</Hint>
        <Hint tone="danger" as="div">
          danger
        </Hint>
      </>,
    );
    const [muted, warning, danger] = [...container.children] as HTMLElement[];
    expect(muted.tagName).toBe('P');
    expect(muted.className).toBe('mgk-type mgk-hint');
    expect(warning.className).toBe('mgk-type mgk-hint mgk-hint--warning');
    expect(danger.tagName).toBe('DIV');
    expect(danger.className).toBe('mgk-type mgk-hint mgk-hint--danger');
    expect(danger).toHaveTextContent('danger');
  });
});

describe('DisabledReason', () => {
  it('has no role by default, as the core run reason', () => {
    const { container } = render(<DisabledReason reason="Generate a mesh first." />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('mgk-type mgk-hint mgk-reason');
    expect(root).not.toHaveAttribute('role');
    expect(root.querySelector('span.mgk-reason-msg')).toHaveTextContent('Generate a mesh first.');
    expect(root.querySelector('button')).toBeNull();
  });

  it('takes a role when given', () => {
    render(<DisabledReason reason="Upload failed." role="alert" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Upload failed.');
  });

  it('the fix is a kit fix button that calls onFix', () => {
    const onFix = vi.fn();
    render(<DisabledReason reason="No solver found." fix={{ label: 'Open Settings', onFix }} />);
    const fix = screen.getByRole('button', { name: 'Open Settings' });
    expect(fix.className).toBe('mgk-btn mgk-btn--fix');
    expect(fix).toHaveAttribute('type', 'button');
    fireEvent.click(fix);
    expect(onFix).toHaveBeenCalledTimes(1);
  });
});

describe('EmptyState', () => {
  it('is a div for a list by default, an li when asked, and has a chart form', () => {
    const { container } = render(
      <>
        <EmptyState>No studies yet.</EmptyState>
        <ul>
          <EmptyState as="li">No monitors.</EmptyState>
        </ul>
        <EmptyState variant="chart">Waiting for the first iteration.</EmptyState>
      </>,
    );
    const list = container.children[0] as HTMLElement;
    expect(list.tagName).toBe('DIV');
    expect(list.className).toBe('mgk-type mgk-empty');
    const li = container.querySelector('ul > li') as HTMLElement;
    expect(li.className).toBe('mgk-type mgk-empty');
    expect(li).toHaveTextContent('No monitors.');
    const chart = container.children[2] as HTMLElement;
    expect(chart.tagName).toBe('DIV');
    expect(chart.className).toBe('mgk-type mgk-empty mgk-empty--chart');
  });
});
