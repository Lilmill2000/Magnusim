// The host's appearance applied to the Part (src/app/appearance.ts): the 3D view's palette now and
// for a view made later, light again on the way back, nothing at all on a host without an
// appearance, the toolbar's scale from the icon scale; nothing else on <html> (the keys to the
// sketch's line colours are CSS tokens), never data-theme (the SDK's).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { installAppearance } from '../../src/app/appearance';
import { createBridge } from '../../src/lib/bridge';
import { createStateStore } from '../../src/lib/store';
import type { AppServices } from '../../src/types/app';
import type { ViewportHandle } from '../../src/types/viewport';
import { TOOLBAR_SCALE_EVENT } from '../../src/ui/Toolbar';
import { DARK, LIGHT, type MarkPalette } from '../../src/viewport/palette';
import { createFakeWorkspace } from '../fakes/workspace-sdk';

afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

function app(appearance?: Record<string, unknown>) {
  const ws = createFakeWorkspace(appearance ? { appearance } : {});
  const bridge = createBridge(ws);
  const viewport = createStateStore<{ handle: ViewportHandle | null }>({ handle: null });
  const services = { bridge, viewport } as unknown as AppServices;
  const view = () => {
    const given: MarkPalette[] = [];
    let live = LIGHT;
    const handle = {
      palette: () => live,
      setPalette: (p: MarkPalette) => {
        live = p;
        given.push(p);
      },
    } as unknown as ViewportHandle;
    return { handle, given };
  };
  const scales: string[] = [];
  const onScale = () => scales.push(document.documentElement.style.getPropertyValue('--cad-toolbar-scale'));
  window.addEventListener(TOOLBAR_SCALE_EVENT, onScale);
  const control = installAppearance(services);
  const done = () => {
    control.dispose();
    window.removeEventListener(TOOLBAR_SCALE_EVENT, onScale);
  };
  return { ws, bridge, viewport, view, control, scales, done };
}

const names = (ps: MarkPalette[]) => ps.map((p) => p.name);

describe('the appearance in the Part', () => {
  it('changes nothing on a host without an appearance: light view, no toolbar scale, no data-theme', () => {
    const a = app();
    const v = a.view();
    a.viewport.set({ handle: v.handle });
    expect(names(v.given)).toEqual(['light']);
    expect(v.handle.palette!()).toBe(LIGHT);
    expect(a.scales).toEqual([]);
    expect(document.documentElement.style.getPropertyValue('--cad-toolbar-scale')).toBe('');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    a.done();
  });

  it('gives a dark view the dark palette at once, a view made later too, and light again on the way back', () => {
    const a = app({ theme: 'dark', preference: 'dark', textScale: 1, iconScale: 1 });
    const v = a.view();
    a.viewport.set({ handle: v.handle });
    expect(v.given).toEqual([DARK]);
    a.ws.push('appearance', { theme: 'light', preference: 'system', textScale: 1, iconScale: 1 });
    expect(v.given).toEqual([DARK, LIGHT]);
    a.ws.push('appearance', { theme: 'dark', preference: 'system', textScale: 1, iconScale: 1 });
    const w = a.view();
    a.viewport.set({ handle: w.handle });
    expect(w.given).toEqual([DARK]);
    expect(a.control.palette()).toBe(DARK);
    // CAD never writes data-theme or color-scheme: the SDK does.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('');
    a.done();
  });

  it('sizes the toolbar by the icon scale (and takes it away at 1)', () => {
    const a = app({ theme: 'light', iconScale: 1.25 });
    expect(a.scales).toEqual(['1.25']);
    a.ws.push('appearance', { theme: 'light', iconScale: 1.5 });
    a.ws.push('appearance', { theme: 'dark', iconScale: 1.5 });
    expect(a.scales).toEqual(['1.25', '1.5']);
    a.ws.push('appearance', { theme: 'dark', iconScale: 1 });
    expect(a.scales).toEqual(['1.25', '1.5', '']);
    expect(document.documentElement.style.getPropertyValue('--cad-toolbar-scale')).toBe('');
    a.done();
  });

  it("writes nothing else on <html> in either theme: the keys to the line colours are the stylesheet's tokens", () => {
    const a = app({ theme: 'light' });
    const v = a.view();
    a.viewport.set({ handle: v.handle });
    expect(document.documentElement.hasAttribute('style')).toBe(false);
    a.ws.push('appearance', { theme: 'dark' });
    expect(v.handle.palette!()).toBe(DARK);
    expect(document.documentElement.hasAttribute('style')).toBe(false);
    a.ws.push('appearance', { theme: 'light' });
    expect(v.handle.palette!()).toBe(LIGHT);
    expect(document.documentElement.hasAttribute('style')).toBe(false);
    a.done();
  });

  it('stops following once disposed', () => {
    const a = app({ theme: 'light' });
    const v = a.view();
    a.viewport.set({ handle: v.handle });
    a.done();
    a.ws.push('appearance', { theme: 'dark' });
    expect(names(v.given)).toEqual(['light']);
  });
});
