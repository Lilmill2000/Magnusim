// The host UI kit (@magnusim/plugin-ui, H14) under CAD's panel pieces: which are the
// kit's own components, which keep CAD's behaviour on the kit's classes, and that the
// data-* hooks the tests use stay on them. The look is compared in the frame by
// e2e/cad-sd-kit.spec.ts; these run the kit's own source (vitest.config.ts alias).
// SPDX-License-Identifier: GPL-3.0-or-later
import { formatSci as kitFormatSci, PLUGIN_UI_API_VERSION } from '@magnusim/plugin-ui';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSci as docFormatSci } from '../../src/doc/units';
import { Switch } from '../../src/features/p2/panel';
import { Button, buttonClass, DisabledReason, EmptyState, Field, formatSci, Hint, PanelChrome, Select } from '../../src/ui/kit';

afterEach(() => cleanup());

describe('the kit components CAD uses as they are', () => {
  it('Select is the kit select, with its options, onChange(value) and the data-field hook on its box', () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select
        id="s"
        label="Operation"
        field="op"
        value="join"
        options={[
          { value: 'join', label: 'Join' },
          { value: 'cut', label: 'Cut' },
        ]}
        onChange={onChange}
      />,
    );
    const select = container.querySelector<HTMLSelectElement>('[data-field="op"] select')!;
    expect(select.className).toBe('mgk-select');
    expect(select.getAttribute('aria-label')).toBe('Operation');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Join', 'Cut']);
    fireEvent.change(select, { target: { value: 'cut' } });
    expect(onChange).toHaveBeenCalledWith('cut');
  });

  it('Field, Hint, DisabledReason and EmptyState render the kit markup', () => {
    const run = vi.fn();
    const { container } = render(
      <div>
        <Field label="Distance" htmlFor="d" field="distance">
          <input id="d" />
        </Field>
        <Hint>A note</Hint>
        <Hint tone="warning">A warning</Hint>
        <DisabledReason fixes={[{ label: 'Retry', run }]}>Extrude 1 failed</DisabledReason>
        <EmptyState attr={{ 'data-params-empty': '1' }}>No parameters yet</EmptyState>
      </div>,
    );
    expect(container.querySelector('[data-field-row="distance"] .mgk-field .mgk-field-k label')!.textContent).toBe('Distance');
    expect(container.querySelector('[data-field-row="distance"] .mgk-field-v input')).not.toBeNull();
    expect([...container.querySelectorAll('div.mgk-hint:not(.mgk-reason)')].map((e) => [e.textContent, e.classList.contains('mgk-hint--warning')])).toEqual([
      ['A note', false],
      ['A warning', true],
    ]);
    const reason = container.querySelector('[data-run-reason] .mgk-reason')!;
    expect(reason.getAttribute('role')).toBe('status');
    expect(reason.querySelector('.mgk-reason-msg')!.textContent).toBe('Extrude 1 failed');
    fireEvent.click(reason.querySelector('button.mgk-btn--fix')!);
    expect(run).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-params-empty] .mgk-empty')!.textContent).toBe('No parameters yet');
  });

  it('Switch is the kit Toggle (a real checkbox) with its words as its label', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<Switch field="knit" label="Knit faces into solids" checked={false} onChange={onChange} />);
    const input = container.querySelector<HTMLInputElement>('[data-switch="knit"] input.mgk-switch-input')!;
    expect(input.type).toBe('checkbox');
    fireEvent.click(container.querySelector('[data-switch="knit"] .cad-switch-label')!);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Switch field="knit" label="Knit faces into solids" checked={false} onChange={onChange} disabledReason="Wait for the current step" />);
    expect(container.querySelector<HTMLInputElement>('[data-switch="knit"] input')!.disabled).toBe(true);
    expect(container.querySelector('[data-switch="knit"]')!.getAttribute('title')).toBe('Wait for the current step');
  });

  it('formatSci is the kit one (the document keeps NaN readable)', () => {
    expect(formatSci).toBe(kitFormatSci);
    for (const v of [0, 20, 62.31559031, 0.00015290, -0.0005, 1234567]) expect(docFormatSci(v)).toBe(kitFormatSci(v));
    expect(docFormatSci(Number.NaN)).toBe('NaN');
    expect(PLUGIN_UI_API_VERSION).toMatch(/^1\./);
  });
});

describe('CAD pieces on the kit classes that keep CAD behaviour', () => {
  it('a Button that cannot act stays focusable, says why and does nothing', () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button variant="primary" disabledReason="Nothing to export" onClick={onClick}>
        Export
      </Button>,
    );
    const b = container.querySelector('button')!;
    expect(b.className).toContain('mgk-btn mgk-btn--primary');
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('data-disabled-reason')).toBe('Nothing to export');
    b.focus();
    expect(document.activeElement).toBe(b);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    expect(buttonClass('done')).toBe('mgk-btn mgk-btn--neutral mgk-panel-done');
    expect(buttonClass('danger')).toBe('mgk-btn mgk-btn--link cad-btn-danger');
  });

  it("PanelChrome has the kit panel's parts, Delete left and Done right, Done disabled with a reason", () => {
    const onDone = vi.fn();
    const onDelete = vi.fn();
    const { container, rerender } = render(
      <PanelChrome panel="feature" title="Combine 1" onDone={onDone} onDelete={onDelete} doneDisabled="Pick at least one target" foot={<Hint>note</Hint>}>
        <p>body</p>
      </PanelChrome>,
    );
    const root = container.querySelector('[data-cad-panel="feature"]')!;
    expect(root.className).toContain('mgk-panel mgk-panel--card');
    expect(root.querySelector('.mgk-panel-head .mgk-panel-title')!.textContent).toBe('Combine 1');
    expect(root.querySelector('.mgk-panel-body')!.textContent).toBe('body');
    expect([...root.querySelectorAll('.mgk-panel-foot button')].map((b) => b.textContent)).toEqual(['Delete', 'Done']);
    expect(root.querySelector('.mgk-panel-foot-left [data-panel-delete]')).not.toBeNull();
    const done = root.querySelector<HTMLButtonElement>('[data-panel-done]')!;
    expect(done.getAttribute('aria-disabled')).toBe('true');
    act(() => void fireEvent.click(done));
    expect(onDone).not.toHaveBeenCalled();
    rerender(
      <PanelChrome panel="feature" title="Combine 1" onDone={onDone}>
        <p>body</p>
      </PanelChrome>,
    );
    // No Delete: the foot's left side stays (empty), so Done keeps its place on the right.
    expect(container.querySelector('.mgk-panel-foot-left')!.childElementCount).toBe(0);
    act(() => void fireEvent.click(container.querySelector('[data-panel-done]')!));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
