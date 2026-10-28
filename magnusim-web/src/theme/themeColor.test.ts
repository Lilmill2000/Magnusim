import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDarkAt, lightProbe, onAppearance, parseColor, themeColor, themeRgb01, themeRgb255 } from './themeColor';
import { darkTokenValues, readTokensCss, tokenValues } from '../test/kitCss';

const light = tokenValues();
const dark = darkTokenValues();

// jsdom cascades custom properties (getPropertyValue) but leaves `color: var(--x)` as written. A
// browser resolves it and spells the result rgb(), or color(srgb ...) for a color-mix(): this
// stand-in does the same on top of jsdom's cascade, so the islands and the probe are real DOM.
const jsdomStyle = window.getComputedStyle.bind(window);
function hexRgb(hex: string): string {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return `rgb(${[0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(', ')})`;
}
function browserStyle(el: Element): CSSStyleDeclaration {
  const cs = jsdomStyle(el);
  const ref = /^var\((--[\w-]+)\)$/.exec(cs.color.trim());
  if (!ref) return cs;
  const v = cs.getPropertyValue(ref[1]).trim();
  // An undefined token: the declaration is invalid and the colour inherited (canvastext here).
  const color = !v ? 'rgb(0, 0, 0)' : /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? hexRgb(v) : v.startsWith('color-mix(') ? 'color(srgb 0.5 0.6 0.7)' : v;
  return { color, getPropertyValue: (name: string) => cs.getPropertyValue(name) } as unknown as CSSStyleDeclaration;
}

const html = document.documentElement;
let sheet: HTMLStyleElement;

beforeAll(() => {
  sheet = document.createElement('style');
  sheet.textContent = `${readTokensCss()}
    :root, [data-theme="light"] { --test-lifted: #3884e6; }
    [data-theme="dark"] { --test-lifted: color-mix(in srgb, #3884e6 70%, white); }
    [data-theme="light"] { --test-light-only: #123456; }`;
  document.head.appendChild(sheet);
});
afterAll(() => sheet.remove());

let gcs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  gcs = vi.spyOn(window, 'getComputedStyle').mockImplementation(browserStyle);
  window.dispatchEvent(new Event('cfd:appearance'));
});
afterEach(() => {
  vi.restoreAllMocks();
  html.removeAttribute('data-theme');
  html.removeAttribute('style');
  document.body.replaceChildren();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('themeColor', () => {
  it('reads a token where it shows, and leaves no probe behind', () => {
    const viewer = document.body.appendChild(document.createElement('div'));
    expect(themeColor('--mg-viewport-bg', viewer)).toBe(hexRgb(light['--mg-viewport-bg']));
    expect(themeColor('--mg-text-ink')).toBe(hexRgb(light['--mg-text-ink']));
    expect(viewer.childElementCount).toBe(0);
    expect(html.querySelectorAll('span').length).toBe(0);
  });

  it('a data-theme="light" island inside a dark page gives light values, the page around it dark', () => {
    html.setAttribute('data-theme', 'dark');
    const island = document.body.appendChild(document.createElement('div'));
    island.setAttribute('data-theme', 'light');
    const viewer = island.appendChild(document.createElement('div'));
    const chrome = document.body.appendChild(document.createElement('div'));
    expect(themeColor('--mg-viewport-bg', viewer)).toBe(hexRgb(light['--mg-viewport-bg']));
    expect(themeColor('--mg-viewport-bg', chrome)).toBe(hexRgb(dark['--mg-viewport-bg']));
    expect(themeColor('--mg-viewport-bg', chrome)).not.toBe(themeColor('--mg-viewport-bg', viewer));
  });

  it('caches per token and scope, never across a theme switch, and clears on cfd:appearance', () => {
    const viewer = document.body.appendChild(document.createElement('div'));
    themeColor('--mg-viewport-bg', viewer);
    themeColor('--mg-viewport-bg', viewer);
    expect(gcs).toHaveBeenCalledTimes(1);
    themeColor('--mg-viewport-bg');
    expect(gcs).toHaveBeenCalledTimes(2);
    // An island put on and taken off in one task (a light export) reads its own value at once.
    viewer.setAttribute('data-theme', 'dark');
    expect(themeColor('--mg-viewport-bg', viewer)).toBe(hexRgb(dark['--mg-viewport-bg']));
    viewer.removeAttribute('data-theme');
    expect(themeColor('--mg-viewport-bg', viewer)).toBe(hexRgb(light['--mg-viewport-bg']));
    const calls = gcs.mock.calls.length;
    window.dispatchEvent(new Event('cfd:appearance'));
    themeColor('--mg-viewport-bg', viewer);
    expect(gcs).toHaveBeenCalledTimes(calls + 1);
  });

  it('gives nothing for a token not defined where it is read, warns once and caches nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(themeColor('--mg-viewport-bgg')).toBe('');
    expect(themeColor('--mg-viewport-bgg')).toBe('');
    expect(gcs).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/--mg-viewport-bgg/);
    expect(themeRgb255('--mg-viewport-bgg')).toEqual([0, 0, 0]);
    expect(warn).toHaveBeenCalledTimes(1);
    // Defined on the light probe only: its light value.
    expect(themeColor('--test-light-only')).toBe('');
    expect(themeRgb255('--test-light-only')).toEqual([0x12, 0x34, 0x56]);
  });
});

describe('parseColor', () => {
  it('reads rgb(), rgba() and hex, and nothing else', () => {
    expect(parseColor('rgb(245, 246, 248)')).toEqual([245, 246, 248, 1]);
    expect(parseColor('rgba(18, 22, 32, 0.42)')).toEqual([18, 22, 32, 0.42]);
    expect(parseColor('rgb(18 22 32 / 42%)')).toEqual([18, 22, 32, 0.42]);
    expect(parseColor('#F0F2F7')).toEqual([240, 242, 247, 1]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#00000080')).toEqual([0, 0, 0, 128 / 255]);
    expect(parseColor('color(srgb 0.5 0.6 0.7)')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor('rgb(1, 2)')).toBeNull();
  });
});

describe('themeRgb255 and themeRgb01', () => {
  it('give the token as bytes and as 0..1, and byte -> float -> byte is the identity', () => {
    expect(themeRgb255('--mg-viewport-ink')).toEqual([0x14, 0x1a, 0x29]);
    expect(themeRgb01('--mg-viewport-bg')).toEqual([0xf0 / 255, 0xf2 / 255, 0xf7 / 255]);
    const plain = Object.keys(light).filter((k) => /^#[0-9a-f]{6}$/i.test(light[k]));
    expect(plain.length).toBeGreaterThan(100);
    for (const k of plain) {
      const bytes = themeRgb255(k);
      expect(bytes, k).toEqual([1, 3, 5].map((i) => parseInt(light[k].slice(i, i + 2), 16)));
      expect(themeRgb01(k).map((v) => Math.round(v * 255)), k).toEqual(bytes);
    }
    for (let v = 0; v <= 255; v++) expect(Math.round((v / 255) * 255)).toBe(v);
  });

  it('a value that is not rgb (a color-mix) warns and gives the light value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    html.setAttribute('data-theme', 'dark');
    expect(themeRgb255('--test-lifted')).toEqual([0x38, 0x84, 0xe6]);
    expect(themeRgb01('--test-lifted')).toEqual([0x38 / 255, 0x84 / 255, 0xe6 / 255]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/--test-lifted/);
  });
});

describe('isDarkAt', () => {
  it("follows the nearest data-theme: html's, or an island inside it (a light capture's)", () => {
    const wrap = document.body.appendChild(document.createElement('div'));
    const viewer = wrap.appendChild(document.createElement('div'));
    expect(isDarkAt(viewer)).toBe(false);
    html.setAttribute('data-theme', 'dark');
    expect(isDarkAt(viewer)).toBe(true);
    wrap.setAttribute('data-theme', 'light');
    expect(isDarkAt(viewer)).toBe(false);
    expect(themeRgb255('--mg-viewport-bg', viewer)).toEqual([0xf0, 0xf2, 0xf7]);
    wrap.removeAttribute('data-theme');
    expect(isDarkAt(viewer)).toBe(true);
    expect(themeRgb255('--mg-viewport-bg', viewer)).toEqual([0x1b, 0x1f, 0x27]);
  });
});

describe('lightProbe', () => {
  it('is one permanent hidden light island on body: light values while the page is dark', () => {
    html.setAttribute('data-theme', 'dark');
    const probe = lightProbe();
    expect(lightProbe()).toBe(probe);
    expect(probe.parentElement).toBe(document.body);
    expect(probe.hidden).toBe(true);
    expect(probe.getAttribute('data-theme')).toBe('light');
    expect(probe.hasAttribute('data-theme-keep')).toBe(true);
    expect(themeColor('--mg-text-ink', probe)).toBe(hexRgb(light['--mg-text-ink']));
    expect(themeColor('--mg-text-ink')).toBe(hexRgb(dark['--mg-text-ink']));
    expect(themeRgb255('--mg-viewport-bg', probe)).toEqual([0xf0, 0xf2, 0xf7]);
    // Gone (body replaced): the next call puts a new one there.
    probe.remove();
    expect(lightProbe()).not.toBe(probe);
    expect(lightProbe().isConnected).toBe(true);
  });
});

describe('onAppearance', () => {
  it("runs on html's data-theme and scale changes and on cfd:appearance, once per change, until unsubscribed", async () => {
    const fn = vi.fn();
    const off = onAppearance(fn);
    html.setAttribute('data-theme', 'dark');
    await settle();
    expect(fn).toHaveBeenCalledTimes(1);
    html.style.setProperty('--mg-text-scale', '1.25');
    await settle();
    expect(fn).toHaveBeenCalledTimes(2);
    // Another inline style on html is not an appearance change.
    html.style.setProperty('--legend-cmap', 'linear-gradient(red, blue)');
    await settle();
    expect(fn).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('cfd:appearance'));
    await settle();
    expect(fn).toHaveBeenCalledTimes(3);
    // The attribute and the event for one change: one call.
    html.setAttribute('data-theme', 'light');
    window.dispatchEvent(new Event('cfd:appearance'));
    await settle();
    expect(fn).toHaveBeenCalledTimes(4);
    off();
    html.setAttribute('data-theme', 'dark');
    await settle();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('a listener reads the new colours, and one that throws does not stop the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    const offBad = onAppearance(() => {
      throw new Error('boom');
    });
    const off = onAppearance(() => seen.push(themeColor('--mg-viewport-bg')));
    expect(themeColor('--mg-viewport-bg')).toBe(hexRgb(light['--mg-viewport-bg']));
    html.setAttribute('data-theme', 'dark');
    await settle();
    expect(seen).toEqual([hexRgb(dark['--mg-viewport-bg'])]);
    expect(warn).toHaveBeenCalled();
    off();
    offBad();
  });
});
