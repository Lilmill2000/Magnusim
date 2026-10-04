// Typed text not applied yet (UX review U1): the window regaining focus with
// nothing focused puts the keyboard back in the field; Enter with nothing
// focused applies the typed text; a refused one keeps its field focused.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPendingEditKeys, registerPendingEdit, type PendingEdit } from '../../src/lib/pendingEdits';

function fakeEdit(over: Partial<PendingEdit> = {}) {
  let pending = true;
  let error: string | null = null;
  const e = {
    label: '+Y padding',
    pending: () => pending,
    error: () => error,
    commit: vi.fn(() => {
      if (over.error) error = 'refused';
      else pending = false;
    }),
    focus: vi.fn(),
    ...over,
  } as PendingEdit & { commit: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  if (over.error) e.error = () => error;
  return { e, setPending: (p: boolean) => (pending = p) };
}

describe('pending edits: focus coming back, Enter with nothing focused', () => {
  let off: () => void = () => {};
  let unregister: () => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers();
    off = installPendingEditKeys(window);
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  afterEach(() => {
    unregister();
    off();
    vi.useRealTimers();
  });

  it('the window regaining focus with nothing focused focuses the field holding typed text', () => {
    const { e } = fakeEdit();
    unregister = registerPendingEdit(e);
    window.dispatchEvent(new FocusEvent('focus'));
    vi.runAllTimers();
    expect(e.focus).toHaveBeenCalledTimes(1);
  });

  it('nothing typed, or something else focused: focus stays where it is', () => {
    const { e, setPending } = fakeEdit();
    unregister = registerPendingEdit(e);
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    window.dispatchEvent(new FocusEvent('focus'));
    vi.runAllTimers();
    expect(e.focus).not.toHaveBeenCalled();
    other.remove();
    setPending(false);
    window.dispatchEvent(new FocusEvent('focus'));
    vi.runAllTimers();
    expect(e.focus).not.toHaveBeenCalled();
  });

  it('Enter with nothing focused applies the typed text, before the page\'s own Enter', () => {
    const { e } = fakeEdit();
    unregister = registerPendingEdit(e);
    const pageEnter = vi.fn();
    document.addEventListener('keydown', pageEnter);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    document.removeEventListener('keydown', pageEnter);
    expect(e.commit).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(pageEnter).not.toHaveBeenCalled();
  });

  it('a refused value keeps its field focused with the reason', () => {
    const { e } = fakeEdit({ error: (() => null) as PendingEdit['error'] });
    unregister = registerPendingEdit(e);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(e.commit).toHaveBeenCalledTimes(1);
    expect(e.focus).toHaveBeenCalledTimes(1);
  });

  it('Enter with nothing typed is left to the page', () => {
    const { e, setPending } = fakeEdit();
    setPending(false);
    unregister = registerPendingEdit(e);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(e.commit).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
