// NumberUnitInput: parsing, units, sci formatting and the core SciNumberInput's
// commit semantics (Enter / blur commit, Escape reverts, untouched never re-saves).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocUnits, Quantity } from '../../src/types/units';
import type { Param } from '../../src/types/doc';
import { NumberUnitInput } from '../../src/ui/kit/NumberUnitInput';
import { createUnitsService } from '../../src/doc/units';
import { createFakeUnits } from './fake-doc';
import { commitPendingEdits, pendingEdits, subscribePendingEdits } from '../../src/lib/pendingEdits';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function setup(opts: { expr: string; units?: DocUnits; params?: Param[]; quantity?: Quantity; validate?: (v: number) => string | null; refuse?: string; raw?: boolean }) {
  const doc = { units: opts.units ?? { length: 'mm', angle: 'deg' }, params: opts.params ?? [] };
  const units = createFakeUnits(() => doc);
  const onCommit = vi.fn((_e: string, _v: number): string | null => opts.refuse ?? null);
  let setExpr: (e: string) => void = () => {};
  function Host() {
    const [expr, set] = useState(opts.expr);
    setExpr = set;
    return (
      <NumberUnitInput
        label="Length"
        expr={expr}
        quantity={opts.quantity ?? 'length'}
        units={units}
        raw={opts.raw}
        validate={opts.validate}
        onCommit={(e, v) => {
          const r = onCommit(e, v);
          if (!r) set(e);
          return r;
        }}
      />
    );
  }
  const view = render(<Host />);
  const input = screen.getByLabelText('Length') as HTMLInputElement;
  const after = () => view.container.querySelector('[data-nui-after]')?.textContent ?? null;
  const error = () => view.container.querySelector('[data-nui-error]')?.textContent ?? null;
  return { input, onCommit, after, error, setExpr: (e: string) => act(() => setExpr(e)), doc };
}

function type(input: HTMLInputElement, text: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}

describe('NumberUnitInput: typed text not applied yet is unsaved work (SD review round 2)', () => {
  it('says so while text waits, applies it when the user leaves, and keeps a refusal with its reason', () => {
    const heard = vi.fn();
    const off = subscribePendingEdits(heard);
    const s = setup({ expr: '10 mm', validate: (v) => (v > 100 ? 'Must be at most 100 mm' : null) });
    expect(pendingEdits()).toEqual({ pending: false, refused: null });
    type(s.input, '7');
    expect(pendingEdits()).toEqual({ pending: true, refused: null });
    expect(heard).toHaveBeenCalled();
    // Leaving (Back, the pointer out of the frame, the page going): applied as Enter would.
    act(() => commitPendingEdits());
    expect(s.onCommit).toHaveBeenCalledWith('7 mm', 7);
    expect(s.input.value).toBe('7');
    expect(pendingEdits()).toEqual({ pending: false, refused: null });
    // A value the field refuses stays, with its reason: still unsaved work, and named.
    type(s.input, '200');
    act(() => commitPendingEdits());
    expect(s.error()).toBe('Must be at most 100 mm');
    expect(s.input.value).toBe('200');
    expect(pendingEdits()).toEqual({ pending: true, refused: { label: 'Length', error: 'Must be at most 100 mm' } });
    act(() => commitPendingEdits());
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    // Escape takes it back: nothing waits. A field that goes takes its text with it.
    fireEvent.keyDown(s.input, { key: 'Escape' });
    expect(pendingEdits()).toEqual({ pending: false, refused: null });
    type(s.input, '9');
    expect(pendingEdits().pending).toBe(true);
    cleanup();
    expect(pendingEdits()).toEqual({ pending: false, refused: null });
    off();
  });
});

describe('NumberUnitInput', () => {
  it('a stored expression that does not evaluate keeps the unit after it, and says why once (P1.5 review round 1)', () => {
    const s = setup({ expr: 'w' });
    expect(s.input.value).toBe('w');
    expect(s.error()).toBe('Unknown parameter "w"');
    expect(s.after()).toBe('mm');
  });

  it('shows a plain value in the display unit with the unit after it', () => {
    const a = setup({ expr: '20 mm' });
    expect(a.input.value).toBe('20');
    expect(a.after()).toBe('mm');
    cleanup();
    const b = setup({ expr: '25.4 mm', units: { length: 'in', angle: 'deg' } });
    expect(b.input.value).toBe('1');
    expect(b.after()).toBe('in');
    cleanup();
    const c = setup({ expr: '1 in' });
    expect(c.input.value).toBe('25.4');
  });

  it('formats values as the readouts do: tiny ones like the core, large ones with digit groups (review round 2)', () => {
    expect(setup({ expr: '0.00001 mm' }).input.value).toBe('1.0000e-5');
    cleanup();
    // It said "2.5000e+6" while the volume chip said "400,000,000 mm³".
    expect(setup({ expr: '2500000 mm' }).input.value).toBe('2,500,000');
    cleanup();
    expect(setup({ expr: '12345.678 mm' }).input.value).toBe('12,345.7');
    cleanup();
    expect(setup({ expr: '20.1234567 mm' }).input.value).toBe('20.1235');
  });

  it('shows every stored digit while focused, so an edit never drops digits; untouched, nothing is re-saved (review round 3)', () => {
    const s = setup({ expr: '12.3456789 mm' });
    expect(s.input.value).toBe('12.3457');
    fireEvent.focus(s.input);
    expect(s.input.value).toBe('12.3456789');
    // Untouched: blur stores nothing and the readout comes back.
    fireEvent.blur(s.input);
    expect(s.onCommit).not.toHaveBeenCalled();
    expect(s.input.value).toBe('12.3457');
    // Focus and Enter without a change: nothing stored either.
    fireEvent.focus(s.input);
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).not.toHaveBeenCalled();
    // An edit of the full text keeps the digits the readout did not show.
    fireEvent.change(s.input, { target: { value: '12.34567891' } });
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).toHaveBeenLastCalledWith('12.34567891 mm', 12.34567891);
    expect(s.input.value).toBe('12.34567891');
    fireEvent.blur(s.input);
    expect(s.input.value).toBe('12.3457');
    cleanup();
    // Large values: grouped as a readout, plain while editing.
    const m = setup({ expr: '1234567.891 mm' });
    expect(m.input.value).toBe('1,234,570');
    fireEvent.focus(m.input);
    expect(m.input.value).toBe('1234567.891');
    fireEvent.blur(m.input);
    expect(m.onCommit).not.toHaveBeenCalled();
    cleanup();
    // Stored in another unit: the converted value to 15 significant digits.
    const c = setup({ expr: '1 in', units: { length: 'mm', angle: 'deg' } });
    fireEvent.focus(c.input);
    expect(c.input.value).toBe('25.4');
    cleanup();
    const t = setup({ expr: '1 mm', units: { length: 'in', angle: 'deg' } });
    expect(t.input.value).toBe('0.0393701');
    fireEvent.focus(t.input);
    expect(t.input.value).toBe('0.0393700787401575');
    fireEvent.blur(t.input);
    expect(t.onCommit).not.toHaveBeenCalled();
  });

  it('refuses a number written with commas, with a reason, as the core number fields do: "1,500" is never guessed (review round 3)', () => {
    const s = setup({ expr: '20 mm' });
    for (const typed of ['1,500', '1,5', '2,000,000']) {
      type(s.input, typed);
      fireEvent.keyDown(s.input, { key: 'Enter' });
      expect(s.onCommit).not.toHaveBeenCalled();
      expect(s.error()).toBe('No commas in numbers: write 1500, or 1.5 for a decimal');
      expect(s.input.value).toBe(typed);
    }
    // A comma between a function's arguments is fine (the document's own evaluator).
    cleanup();
    const doc = { units: { length: 'mm', angle: 'deg' } as DocUnits, params: [] as Param[] };
    const units = createUnitsService(
      () => doc.units,
      () => doc.params,
    );
    const onCommit = vi.fn(() => null);
    render(<NumberUnitInput label="Length" expr="20 mm" quantity="length" units={units} onCommit={onCommit} />);
    const input = screen.getByLabelText('Length') as HTMLInputElement;
    type(input, 'max(10, 25)');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith('max(10, 25)', 25);
  });

  it('shows an expression as typed, with its value after it', () => {
    const s = setup({ expr: 'width / 2', params: [{ id: 'p1', name: 'width', expr: '25 mm', quantity: 'length' }] });
    expect(s.input.value).toBe('width / 2');
    expect(s.after()).toBe('= 12.5 mm');
  });

  it('commits on Enter, storing a bare number with the display unit', () => {
    const s = setup({ expr: '20 mm' });
    type(s.input, '42');
    expect(s.onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).toHaveBeenCalledWith('42 mm', 42);
    expect(s.input.value).toBe('42');
  });

  it('commits on blur, in the document unit', () => {
    const s = setup({ expr: '1 in', units: { length: 'in', angle: 'deg' } });
    expect(s.input.value).toBe('1');
    type(s.input, '2.5');
    fireEvent.blur(s.input);
    expect(s.onCommit).toHaveBeenCalledWith('2.5 in', 63.5);
  });

  it('keeps an explicit unit and expressions as typed', () => {
    const s = setup({ expr: '20 mm', params: [{ id: 'p1', name: 'w', expr: '10 mm', quantity: 'length' }] });
    type(s.input, '1 in');
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).toHaveBeenLastCalledWith('1 in', 25.4);
    expect(s.input.value).toBe('25.4');
    type(s.input, ' w * 3 ');
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).toHaveBeenLastCalledWith('w * 3', 30);
    expect(s.input.value).toBe('w * 3');
    expect(s.after()).toBe('= 30 mm');
  });

  it('never re-saves an untouched field (the rounded text is not stored)', () => {
    const s = setup({ expr: '20.1234567 mm' });
    fireEvent.focus(s.input);
    fireEvent.blur(s.input);
    fireEvent.focus(s.input);
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).not.toHaveBeenCalled();
    // The same value typed differently is not a change either.
    type(s.input, '20.1234567');
    fireEvent.blur(s.input);
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it('Escape reverts to the stored value without committing', () => {
    const s = setup({ expr: '20 mm' });
    type(s.input, '99');
    fireEvent.keyDown(s.input, { key: 'Escape' });
    expect(s.input.value).toBe('20');
    fireEvent.blur(s.input);
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it('shows why an entry is invalid, keeps the text and applies nothing', () => {
    const s = setup({ expr: '20 mm' });
    type(s.input, '20 kg');
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).not.toHaveBeenCalled();
    expect(s.input.value).toBe('20 kg');
    expect(s.input.getAttribute('aria-invalid')).toBe('true');
    expect(s.error()).toBe('Unexpected "kg"');
    // Typing again clears the message; Escape brings the stored value back.
    fireEvent.change(s.input, { target: { value: '20 k' } });
    expect(s.error()).toBeNull();
    fireEvent.keyDown(s.input, { key: 'Escape' });
    expect(s.input.value).toBe('20');
    expect(s.input.getAttribute('aria-invalid')).toBeNull();

    type(s.input, 'depth');
    fireEvent.blur(s.input);
    expect(s.error()).toBe('Unknown parameter "depth"');
    expect(s.onCommit).not.toHaveBeenCalled();

    type(s.input, '   ');
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.error()).toBe('Enter a value');
  });

  it('refuses a value the field rule rejects', () => {
    const s = setup({ expr: '20 mm', validate: (v) => (v > 0 ? null : 'Length must be more than 0') });
    type(s.input, '-5');
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.error()).toBe('Length must be more than 0');
    expect(s.onCommit).not.toHaveBeenCalled();
    type(s.input, '0');
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.error()).toBe('Length must be more than 0');
  });

  it('shows the reason when the document refuses the change', () => {
    const s = setup({ expr: '20 mm', refuse: 'Box 1 cannot be edited now' });
    type(s.input, '30');
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).toHaveBeenCalledWith('30 mm', 30);
    expect(s.error()).toBe('Box 1 cannot be edited now');
    expect(s.input.value).toBe('30');
  });

  it('follows the stored expression when it changes upstream (undo), but not while typing', () => {
    const s = setup({ expr: '20 mm' });
    s.setExpr('35 mm');
    expect(s.input.value).toBe('35');
    type(s.input, '7');
    s.setExpr('40 mm');
    expect(s.input.value).toBe('7');
  });

  it('shows the stored expression error when a parameter it used is gone', () => {
    const s = setup({ expr: 'gone * 2' });
    expect(s.input.value).toBe('gone * 2');
    expect(s.error()).toBe('Unknown parameter "gone"');
  });

  it('handles angles and plain numbers', () => {
    const a = setup({ expr: '15 deg', quantity: 'angle' });
    expect(a.input.value).toBe('15');
    expect(a.after()).toBe('°');
    type(a.input, '30');
    fireEvent.keyDown(a.input, { key: 'Enter' });
    expect(a.onCommit).toHaveBeenCalledWith('30 deg', 30);
    cleanup();
    const n = setup({ expr: '4', quantity: 'scalar' });
    expect(n.after()).toBeNull();
    type(n.input, '6');
    fireEvent.keyDown(n.input, { key: 'Enter' });
    expect(n.onCommit).toHaveBeenCalledWith('6', 6);
  });

  it('Ctrl+Z: nothing typed hands it to the app (data-undo-to-app, no text undo); typed and not applied puts the applied value back first (review P2/P3 round 3)', () => {
    const s = setup({ expr: '45 mm' });
    fireEvent.focus(s.input);
    expect(s.input.getAttribute('data-undo-to-app')).toBe('1');
    type(s.input, '50');
    expect(s.input.hasAttribute('data-undo-to-app')).toBe(false);
    fireEvent.keyDown(s.input, { key: 'Enter' });
    expect(s.onCommit).toHaveBeenCalledWith('50 mm', 50);
    // Applied, focus still in the field: the app's Undo takes Ctrl+Z (the browser's text undo showed 45).
    expect(s.input.getAttribute('data-undo-to-app')).toBe('1');
    const passed = fireEvent.keyDown(s.input, { key: 'z', ctrlKey: true });
    expect(passed).toBe(true);
    expect(s.input.value).toBe('50');
    // Typed, not applied: Ctrl+Z drops the typing (the event goes no further), then hands on again.
    type(s.input, '35');
    const handled = !fireEvent.keyDown(s.input, { key: 'z', ctrlKey: true });
    expect(handled).toBe(true);
    expect(s.input.value).toBe('50');
    expect(s.input.getAttribute('data-undo-to-app')).toBe('1');
    expect(s.onCommit).toHaveBeenCalledTimes(1);
  });

  it('raw mode (parameter table) shows the expression exactly as stored', () => {
    const s = setup({ expr: '1 in', raw: true });
    expect(s.input.value).toBe('1 in');
  });
});
