// The bridge's appearance accessors (src/lib/bridge.ts): feature detection on
// ws.context.appearance (an older host has none: light, scale 1, no events heard), the host's
// 'appearance' event followed, and the values CAD takes from what a host sends.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { appearanceOf, createBridge, LIGHT_APPEARANCE } from '../../src/lib/bridge';
import { createFakeWorkspace } from '../fakes/workspace-sdk';

describe('Bridge appearance', () => {
  it('is light at scale 1 on a host without one, and hears nothing it pushes', () => {
    const ws = createFakeWorkspace();
    const b = createBridge(ws);
    expect(b.appearance()).toEqual({ theme: 'light', preference: 'light', textScale: 1, iconScale: 1 });
    expect(b.theme()).toBe('light');
    const fn = vi.fn();
    b.onAppearance(fn);
    // An older SDK has no such event; even a stray one is not taken (no ctx.appearance: not offered).
    ws.push('appearance', { theme: 'dark' });
    expect(fn).not.toHaveBeenCalled();
    expect(b.theme()).toBe('light');
    expect(LIGHT_APPEARANCE).toEqual({ theme: 'light', preference: 'light', textScale: 1, iconScale: 1 });
  });

  it("reads the host's appearance at the start and follows its 'appearance' event", () => {
    const ws = createFakeWorkspace({ appearance: { theme: 'dark', preference: 'system', textScale: 1.1, iconScale: 1.25 } });
    const b = createBridge(ws);
    expect(b.appearance()).toEqual({ theme: 'dark', preference: 'system', textScale: 1.1, iconScale: 1.25 });
    expect(b.theme()).toBe('dark');
    const seen: unknown[] = [];
    const off = b.onAppearance((a) => seen.push(a));
    ws.push('appearance', { theme: 'light', preference: 'light', textScale: 1, iconScale: 1 });
    expect(seen).toEqual([{ theme: 'light', preference: 'light', textScale: 1, iconScale: 1 }]);
    expect(b.theme()).toBe('light');
    off();
    ws.push('appearance', { theme: 'dark', preference: 'dark', textScale: 1, iconScale: 1 });
    expect(seen.length).toBe(1);
    expect(b.theme()).toBe('dark');
  });

  it('takes "dark" in any case as dark and anything else as light; a scale out of 0.5..3 is 1', () => {
    expect(appearanceOf({ theme: 'Dark' }).theme).toBe('dark');
    expect(appearanceOf({ theme: ' dark ' }).theme).toBe('dark');
    for (const t of ['system', 'light', 'x', 7, null, undefined]) expect(appearanceOf({ theme: t }).theme).toBe('light');
    expect(appearanceOf(null)).toEqual({ theme: 'light', preference: 'light', textScale: 1, iconScale: 1 });
    expect(appearanceOf({ theme: 'dark' }).preference).toBe('dark');
    expect(appearanceOf({ theme: 'dark', preference: 'nope' }).preference).toBe('dark');
    expect(appearanceOf({ textScale: 1.5, iconScale: 0.9 })).toMatchObject({ textScale: 1.5, iconScale: 0.9 });
    for (const s of [0, -1, 9, Number.NaN, '1.25']) expect(appearanceOf({ iconScale: s }).iconScale).toBe(1);
  });

  it("takes the host's event as CAD takes any appearance, and a listener that throws does not stop the others", () => {
    const ws = createFakeWorkspace({ appearance: { theme: 'light', preference: 'light', textScale: 1, iconScale: 1 } });
    const b = createBridge(ws);
    const fn = vi.fn();
    b.onAppearance(fn);
    ws.push('appearance', { theme: 'dark', iconScale: 1.5 });
    expect(fn).toHaveBeenCalledWith({ theme: 'dark', preference: 'dark', textScale: 1, iconScale: 1.5 });
    expect(b.theme()).toBe('dark');
    const later = vi.fn();
    b.onAppearance(() => {
      throw new Error('boom');
    });
    b.onAppearance(later);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    ws.push('appearance', { theme: 'light' });
    expect(later).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
