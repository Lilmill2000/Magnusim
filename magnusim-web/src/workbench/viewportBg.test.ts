import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { themeRgb01 } from '../theme/themeColor';
import { darkTokenValues, readTokensCss, tokenValues } from '../test/kitCss';

// viewportBg as runtime.js has it; themeRgb01 is the theme module's.
const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'runtime.js'), 'utf8');
const source = runtime.match(/^function viewportBg\([\s\S]*?^}/m);
if (!source) throw new Error('runtime.js has no function viewportBg');
const viewportBg = new Function('themeRgb01', `${source[0]}\nreturn viewportBg;`)(themeRgb01) as (scopeEl?: Element | null) => number[];

const rgb01 = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const light = rgb01(tokenValues()['--mg-viewport-bg']);
const dark = rgb01(darkTokenValues()['--mg-viewport-bg']);

// jsdom cascades custom properties but leaves `color: var(--x)` as written; a browser resolves it
// to rgb(). This stand-in does that on top of jsdom's cascade (as in src/theme/themeColor.test.ts).
const jsdomStyle = window.getComputedStyle.bind(window);
function browserStyle(el: Element): CSSStyleDeclaration {
  const cs = jsdomStyle(el);
  const ref = /^var\((--[\w-]+)\)$/.exec(cs.color.trim());
  if (!ref) return cs;
  const v = cs.getPropertyValue(ref[1]).trim();
  const color = /^#[0-9a-f]{6}$/i.test(v) ? `rgb(${[1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).join(', ')})` : v;
  return { color, getPropertyValue: (name: string) => cs.getPropertyValue(name) } as unknown as CSSStyleDeclaration;
}

const html = document.documentElement;
let sheet: HTMLStyleElement;

beforeAll(() => {
  sheet = document.createElement('style');
  sheet.textContent = readTokensCss();
  document.head.appendChild(sheet);
});
afterAll(() => sheet.remove());

beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(browserStyle);
  window.dispatchEvent(new Event('cfd:appearance'));
});
afterEach(() => {
  vi.restoreAllMocks();
  html.removeAttribute('data-theme');
  document.body.replaceChildren();
});

function addViewer(id: string, parent: Element = document.body): HTMLElement {
  const el = parent.appendChild(document.createElement('div'));
  el.id = id;
  return el;
}

describe('viewportBg', () => {
  it('is --mg-viewport-bg where #viewer shows, by default, in either theme', () => {
    addViewer('viewer');
    expect(light).not.toEqual(dark);
    expect(viewportBg()).toEqual(light);
    html.setAttribute('data-theme', 'dark');
    expect(viewportBg()).toEqual(dark);
  });

  it('reads #viewer-b where it shows: a light island in a dark page, then dark once the island goes', () => {
    html.setAttribute('data-theme', 'dark');
    addViewer('viewer');
    const island = document.body.appendChild(document.createElement('div'));
    island.setAttribute('data-theme', 'light');
    const viewerB = addViewer('viewer-b', island);
    expect(viewportBg(viewerB)).toEqual(light);
    expect(viewportBg()).toEqual(dark);
    island.removeAttribute('data-theme');
    window.dispatchEvent(new Event('cfd:appearance'));
    expect(viewportBg(viewerB)).toEqual(dark);
  });
});
