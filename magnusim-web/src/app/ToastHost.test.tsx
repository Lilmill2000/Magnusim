import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ruleProps } from '../test/kitCss';
import { ToastHost } from './ToastHost';

function pluginFailed(message: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent('cfd:plugin-toast', { detail: message }));
  });
}

function toast(message: unknown, kind?: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent('cfd:toast', { detail: { message, kind } }));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const region = () => screen.getByRole('region', { name: 'Notifications' });
const shown = () => [...region().querySelectorAll('.mgk-toast')].map((el) => el.querySelector('.mgk-toast-msg')?.textContent);

describe('ToastHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the app toast region, bottom right (style.css), empty at first', () => {
    render(<ToastHost />);
    expect(region()).toHaveClass('app-toasts');
    expect(region().children).toHaveLength(0);
  });

  it('shows a plugin that failed to load as an error toast marked data-plugin-toast', () => {
    render(<ToastHost />);
    pluginFailed('Broken UI: ui failed');
    const el = region().querySelector('.mgk-toast') as HTMLElement;
    expect(el.className).toBe('mgk-type mgk-toast mgk-toast--error');
    expect(el).toHaveAttribute('data-plugin-toast', '1');
    expect(el).toHaveTextContent('Broken UI: ui failed');
  });

  it("shows a plugin's own toast with its kind, without data-plugin-toast", () => {
    render(<ToastHost />);
    toast('Saved', 'success');
    toast('Heads up', 'info');
    toast('Nope', 'error');
    const els = [...region().querySelectorAll('.mgk-toast')];
    expect(els.map((el) => el.className)).toEqual([
      'mgk-type mgk-toast mgk-toast--success',
      'mgk-type mgk-toast mgk-toast--info',
      'mgk-type mgk-toast mgk-toast--error',
    ]);
    for (const el of els) expect(el).not.toHaveAttribute('data-plugin-toast');
  });

  it('turns an unknown kind into info, caps the message at 300 characters and ignores an empty one', () => {
    render(<ToastHost />);
    toast('', 'error');
    pluginFailed('');
    expect(region().children).toHaveLength(0);
    toast('x'.repeat(400), 'warning');
    const el = region().querySelector('.mgk-toast') as HTMLElement;
    expect(el).toHaveClass('mgk-toast--info');
    expect(el.querySelector('.mgk-toast-msg')?.textContent).toHaveLength(300);
  });

  it('shows three at most, newest last, dropping the oldest', () => {
    render(<ToastHost />);
    for (const m of ['one', 'two', 'three', 'four']) toast(m);
    expect(shown()).toEqual(['two', 'three', 'four']);
  });

  it('closes each after its own time: info at 3.8 s, a failed plugin at 9 s', () => {
    render(<ToastHost />);
    toast('Saved');
    pluginFailed('Broken UI: ui failed');
    advance(3800);
    expect(shown()).toEqual(['Broken UI: ui failed']);
    advance(5200);
    expect(shown()).toEqual([]);
  });

  it('× closes that toast only', () => {
    render(<ToastHost />);
    toast('one');
    toast('two');
    fireEvent.click(region().querySelectorAll('.mgk-toast-close')[0]);
    expect(shown()).toEqual(['two']);
  });

  it('a second, different toast arriving at 3 s does not delay the first one closing at 3.8 s', () => {
    render(<ToastHost />);
    toast('first');
    advance(3000);
    toast('second');
    expect(shown()).toEqual(['first', 'second']);
    advance(800);
    expect(shown()).toEqual(['second']);
    advance(3000);
    expect(shown()).toEqual([]);
  });

  it('the same message and kind again restarts its time instead of adding a copy', () => {
    render(<ToastHost />);
    toast('Saved', 'success');
    advance(3000);
    toast('Saved', 'success');
    expect(shown()).toEqual(['Saved']);
    advance(800);
    expect(shown()).toEqual(['Saved']);
    advance(2999);
    expect(shown()).toEqual(['Saved']);
    advance(1);
    expect(shown()).toEqual([]);
    // The same text as another kind is another toast.
    toast('Saved', 'success');
    toast('Saved', 'error');
    expect(shown()).toEqual(['Saved', 'Saved']);
  });

  it('the same failed plugin again restarts its toast, still marked', () => {
    render(<ToastHost />);
    pluginFailed('Broken UI: ui failed');
    advance(8000);
    pluginFailed('Broken UI: ui failed');
    const els = region().querySelectorAll('.mgk-toast');
    expect(els).toHaveLength(1);
    expect(els[0]).toHaveAttribute('data-plugin-toast', '1');
    advance(8999);
    expect(shown()).toEqual(['Broken UI: ui failed']);
    advance(1);
    expect(shown()).toEqual([]);
  });

  it('pointing at any toast holds them all, so none slides out from under the pointer', () => {
    render(<ToastHost />);
    toast('older');
    toast('newer');
    const older = region().querySelectorAll('.mgk-toast')[0];
    fireEvent.mouseEnter(older);
    advance(20_000);
    expect(shown()).toEqual(['older', 'newer']);
    // One that comes while the pointer is there waits too.
    toast('third', 'error');
    advance(20_000);
    expect(shown()).toEqual(['older', 'newer', 'third']);
    // Leaving starts each one again from its full time.
    fireEvent.mouseLeave(older);
    advance(3799);
    expect(shown()).toEqual(['older', 'newer', 'third']);
    advance(1);
    expect(shown()).toEqual(['third']);
    advance(5200);
    expect(shown()).toEqual([]);
  });

  it('closing the last toast under the pointer does not hold the next one', () => {
    render(<ToastHost />);
    toast('only');
    const only = region().querySelector('.mgk-toast') as HTMLElement;
    fireEvent.mouseEnter(only);
    // × removes it with the pointer still there: no mouseleave comes.
    fireEvent.click(only.querySelector('.mgk-toast-close') as HTMLElement);
    expect(shown()).toEqual([]);
    toast('next');
    advance(3800);
    expect(shown()).toEqual([]);
  });

  it('stops listening when it unmounts', () => {
    const { unmount } = render(<ToastHost />);
    unmount();
    toast('late');
    pluginFailed('late');
    expect(document.querySelector('.mgk-toast')).toBeNull();
  });
});

// jsdom does not lay out the page; the h14 e2e checks the toasts draw above a workspace.
describe('the app toast region in style.css', () => {
  const appCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');

  it('sits fixed at the bottom right, above the workspace overlay, and lets clicks through between toasts', () => {
    expect(ruleProps(appCss, '.app-toasts')).toEqual({
      position: 'fixed',
      right: 'var(--mg-space-4)',
      bottom: 'var(--mg-space-4)',
      'z-index': 'var(--mg-z-toast)',
      display: 'flex',
      'flex-direction': 'column',
      gap: 'var(--mg-space-2)',
      'align-items': 'flex-end',
      'pointer-events': 'none',
    });
  });
});
