// The host's appearance applied to the Part (src/app/appearance.ts): the 3D view's palette now and
// for a view made later, light again on the way back, nothing at all on a host without an
// appearance, the toolbar's scale from the icon scale, E1 / E2's switch, the keys to the sketch's
// line colours from the palette while dark; never data-theme (the SDK's).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { installAppearance, SKETCH_KEYS } from '../../src/app/appearance';
import { createBridge } from '../../src/lib/bridge';
import { createStateStore } from '../../src/lib/store';
import type { AppServices } from '../../src/types/app';
import type { ViewportHandle } from '../../src/types/viewport';
import { TOOLBAR_SCALE_EVENT } from '../../src/ui/Toolbar';
import { DARK, darkPalette, LIGHT, type MarkPalette } from '../../src/viewport/palette';
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

const names = (ps: MarkPalette[]) => ps.map((p) => (p.lines ? `${p.name}:${p.lines.edges}${p.lines.sketch}` : p.name));

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
    expect(names(v.given)).toEqual(['dark:cc']);
    a.ws.push('appearance', { theme: 'light', preference: 'system', textScale: 1, iconScale: 1 });
    expect(names(v.given)).toEqual(['dark:cc', 'light']);
    a.ws.push('appearance', { theme: 'dark', preference: 'system', textScale: 1, iconScale: 1 });
    const w = a.view();
    a.viewport.set({ handle: w.handle });
    expect(names(w.given)).toEqual(['dark:cc']);
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

  it("switches E1 / E2's candidates (one for both, or each apart) and applies them while dark", () => {
    const a = app({ theme: 'dark' });
    const v = a.view();
    a.viewport.set({ handle: v.handle });
    expect(a.control.darkLines()).toEqual({ edges: 'c', sketch: 'c' });
    expect(a.control.darkLines('b')).toEqual({ edges: 'b', sketch: 'b' });
    expect(a.control.darkLines({ sketch: 'a' })).toEqual({ edges: 'b', sketch: 'a' });
    // Nonsense is ignored.
    expect(a.control.darkLines({ edges: 'z' as never })).toEqual({ edges: 'b', sketch: 'a' });
    expect(names(v.given)).toEqual(['dark:cc', 'dark:bb', 'dark:ba', 'dark:ba']);
    expect(v.handle.palette!().edgeRim).toBe(0x1b1f27);
    // Kept for the dark view while light; light draws LIGHT.
    a.ws.push('appearance', { theme: 'light' });
    expect(v.handle.palette!()).toBe(LIGHT);
    a.ws.push('appearance', { theme: 'dark' });
    expect(names(v.given).at(-1)).toBe('dark:ba');
    a.done();
  });

  it("sets the keys to the sketch's line colours from the palette while dark (E2's candidate's), and none in light", () => {
    const keys = () => Object.fromEntries(Object.keys(SKETCH_KEYS).map((k) => [k.replace('--cad-sketch-key-', ''), document.documentElement.style.getPropertyValue(k)]));
    const a = app({ theme: 'light' });
    const v = a.view();
    a.viewport.set({ handle: v.handle });
    // Light: no key on <html> (the stylesheet's light values are LIGHT's inks), no style attribute at all.
    expect(keys()).toEqual({ under: '', full: '', over: '', linked: '', lost: '' });
    expect(document.documentElement.hasAttribute('style')).toBe(false);
    a.ws.push('appearance', { theme: 'dark' });
    // (c), the default: the mid tones the lines are drawn in, a fully defined sketch's dot the mid grey.
    expect(keys()).toEqual({ under: DARK.sketch.under, full: '#8a93a3', over: DARK.sketch.over, linked: DARK.sketch.linked, lost: DARK.sketch.lost });
    a.control.darkLines({ sketch: 'a' });
    const pa = darkPalette({ sketch: 'a' });
    expect(keys()).toEqual({ under: pa.sketch.under, full: '#e6e9ef', over: pa.sketch.over, linked: pa.sketch.linked, lost: pa.sketch.lost });
    // Each key is the colour the view's lines are drawn in now.
    const live = v.handle.palette!().sketch;
    expect(keys()).toEqual({ under: live.under, full: live.fully, over: live.over, linked: live.linked, lost: live.lost });
    a.ws.push('appearance', { theme: 'light' });
    expect(keys()).toEqual({ under: '', full: '', over: '', linked: '', lost: '' });
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
