// @vitest-environment jsdom
// The page follows the host's unit system and the engine's changes, including a change that
// lands between the first render and the moment the page starts listening (the frame mounting),
// and the page's theme (colours read from the tokens are read again when it changes).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { onAppearance, useAppearance, useEngineTick, useWorkspaceUnits } from '../src/app/hooks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Units = 'metric' | 'imperial';

/** A host whose units change just before the page subscribes (the change event goes to nobody). */
function lateHost() {
  const listeners = new Set<(u: Units) => void>();
  const ws = {
    context: { units: 'metric' as Units },
    on(_e: 'units', fn: (u: Units) => void) {
      // The host's message arrived first: the SDK updated the context and told its listeners (none yet).
      ws.context.units = 'imperial';
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    send(u: Units) {
      ws.context.units = u;
      for (const fn of listeners) fn(u);
    },
  };
  return ws;
}

describe('the unit system', () => {
  it('a change that lands as the page mounts is shown', () => {
    const ws = lateHost();
    function Show() {
      return createElement('span', { 'data-u': '1' }, useWorkspaceUnits(ws, ws.context.units));
    }
    const { container } = render(createElement(Show));
    expect(container.textContent).toBe('imperial');
  });

  it('and later changes too', () => {
    const ws = lateHost();
    function Show() {
      return createElement('span', null, useWorkspaceUnits(ws, ws.context.units));
    }
    const { container } = render(createElement(Show));
    act(() => ws.send('metric'));
    expect(container.textContent).toBe('metric');
  });
});

describe('the engine', () => {
  it('a change announced between the render and the subscription is drawn', () => {
    const engine = {
      value: 1,
      fns: new Set<() => void>(),
      subscribe(fn: () => void) {
        // The engine moved on (and announced it to nobody) before the panel listened.
        engine.value = 2;
        engine.fns.add(fn);
        return () => engine.fns.delete(fn);
      },
    };
    function Panel() {
      useEngineTick(engine);
      return createElement('span', null, String(engine.value));
    }
    const { container } = render(createElement(Panel));
    expect(container.textContent).toBe('2');
    act(() => {
      engine.value = 3;
      for (const fn of engine.fns) fn();
    });
    expect(container.textContent).toBe('3');
  });
});

describe('the page theme', () => {
  /** Lets the mutation observers' callbacks run. */
  const settle = () => new Promise((r) => setTimeout(r, 0));
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.body.removeAttribute('data-theme');
  });

  it('each change of html data-theme is heard, and nothing once stopped', async () => {
    let n = 0;
    const stop = onAppearance(() => n++);
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();
    expect(n).toBe(1);
    // Another attribute, or a theme of an element in the page (the stage's own), is not the page's theme.
    document.documentElement.setAttribute('lang', 'en');
    document.body.setAttribute('data-theme', 'light');
    await settle();
    expect(n).toBe(1);
    stop();
    document.documentElement.setAttribute('data-theme', 'light');
    await settle();
    expect(n).toBe(1);
  });

  it('an effect that depends on useAppearance reads the colours again after a change', async () => {
    const reads: string[] = [];
    function View() {
      const appearance = useAppearance();
      useEffect(() => {
        reads.push(document.documentElement.getAttribute('data-theme') ?? 'none');
      }, [appearance]);
      return null;
    }
    const { unmount } = render(createElement(View));
    expect(reads).toEqual(['none']);
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      await settle();
    });
    expect(reads).toEqual(['none', 'dark']);
    // Unmounted, it stops listening.
    unmount();
    document.documentElement.setAttribute('data-theme', 'light');
    await settle();
    expect(reads).toEqual(['none', 'dark']);
  });
});
