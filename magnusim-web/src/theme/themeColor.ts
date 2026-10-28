/**
 * Theme colours for what CSS does not paint: vtk actors and backgrounds, canvas captures, WebGPU.
 * A token is read where its colour shows (inside `scope`), so a data-theme island gives its own
 * value: [data-theme="light"] inside a dark page, or lightProbe() for the files that stay light.
 *
 * The value is a hidden probe's computed colour (color: var(token)): the browser resolves nested
 * var() and the island's cascade, and spells the result rgb() or rgba(). A token read here is plain
 * hex or rgb in every block (src/theme/tokens.test.ts): a color-mix() computes to color(srgb ...),
 * which themeRgb01 and themeRgb255 do not take.
 */

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

// Per scope element: "<theme>|<token>" -> computed colour. The scope's theme is part of the key, so
// a switch (html's data-theme, or an island put on and taken off in one task) never reads a stale
// value; an appearance change clears it all.
let cache = new WeakMap<Element, Map<string, string>>();

/** The theme a scope paints in: its nearest data-theme (an island, or html's). */
function themeOf(scope: Element): string {
  return scope.closest('[data-theme]')?.getAttribute('data-theme') ?? '';
}

/** Whether `scope` paints in the dark theme (its nearest data-theme, an island or html's, is dark). */
export function isDarkAt(scope: Element): boolean {
  return themeOf(scope) === 'dark';
}

// Tokens already warned about (DEV) as not defined where they were read: once each.
const warnedUndefined = new Set<string>();

/**
 * A token's colour where it shows: the computed colour of `color: var(token)` inside `scope`; ''
 * when the token is not defined there (misspelt, or not added yet), never cached.
 */
export function themeColor(token: string, scope?: Element | null): string {
  watchAppearance();
  const el = scope ?? document.documentElement;
  const key = `${themeOf(el)}|${token}`;
  let byToken = cache.get(el);
  const hit = byToken?.get(key);
  if (hit !== undefined) return hit;
  const probe = document.createElement('span');
  probe.style.setProperty('display', 'none');
  probe.style.setProperty('color', `var(${token})`);
  el.appendChild(probe);
  let value = '';
  let defined = false;
  try {
    const style = window.getComputedStyle(probe);
    // An undefined token makes `color: var(token)` invalid, and the probe would inherit the text
    // colour around it: that is not the token's colour.
    defined = style.getPropertyValue(token).trim() !== '';
    if (defined) value = style.color;
  } finally {
    probe.remove();
  }
  if (!defined) {
    if (import.meta.env.DEV && !warnedUndefined.has(token)) {
      warnedUndefined.add(token);
      console.warn(`[theme] ${token} is not defined where it was read`);
    }
    return '';
  }
  if (!byToken) cache.set(el, (byToken = new Map()));
  byToken.set(key, value);
  return value;
}

/** A colour as [r, g, b, a] (0..255, alpha 0..1): rgb(), rgba() and hex; null for any other form. */
export function parseColor(css: string): Rgba | null {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const byte = (i: number) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255);
    return [byte(0), byte(2), byte(4), byte(6) / 255];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channel = (p: string) => (p.endsWith('%') ? Number(p.slice(0, -1)) * 2.55 : Number(p));
  const alpha = (p: string | undefined) => (p === undefined ? 1 : p.endsWith('%') ? Number(p.slice(0, -1)) / 100 : Number(p));
  const out: Rgba = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha(parts[3])];
  return out.every(Number.isFinite) ? out : null;
}

const toByte = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

/** A token's colour where it shows, as [r, g, b] in 0..255 (vtk's AxesActor, canvas pixels). */
export function themeRgb255(token: string, scope?: Element | null): Rgb {
  const value = themeColor(token, scope);
  const c = parseColor(value);
  if (c) return [toByte(c[0]), toByte(c[1]), toByte(c[2])];
  // Not rgb (a color-mix computes to color(srgb ...)), or not defined there (themeColor warned):
  // the light value, so the view still paints.
  if (import.meta.env.DEV && value) console.warn(`[theme] ${token} computes to "${value}", not rgb(): its light value is used`);
  const probe = lightProbe();
  const light = scope === probe ? null : parseColor(themeColor(token, probe));
  return light ? [toByte(light[0]), toByte(light[1]), toByte(light[2])] : [0, 0, 0];
}

/** A token's colour where it shows, as [r, g, b] in 0..1 (vtk's setColor and setBackground). */
export function themeRgb01(token: string, scope?: Element | null): Rgb {
  const [r, g, b] = themeRgb255(token, scope);
  return [r / 255, g / 255, b / 255];
}

let probeEl: HTMLElement | null = null;

/**
 * A permanent hidden light island on body: themeColor(token, lightProbe()) is the token's light
 * value whatever the page's theme (exports that stay light). data-theme-keep marks it as meant to stay.
 */
export function lightProbe(): HTMLElement {
  if (probeEl?.isConnected) return probeEl;
  probeEl = document.createElement('div');
  probeEl.hidden = true;
  probeEl.style.setProperty('display', 'none');
  probeEl.setAttribute('data-theme', 'light');
  probeEl.setAttribute('data-theme-keep', '');
  document.body.appendChild(probeEl);
  return probeEl;
}

const listeners = new Set<() => void>();
let watching = false;
let lastKey = '';
let notifyQueued = false;

/** What html's appearance is: its theme and its text and icon scales (its inline style). */
function appearanceKey(): string {
  const html = document.documentElement;
  return [html.getAttribute('data-theme') ?? '', html.style.getPropertyValue('--mg-text-scale'), html.style.getPropertyValue('--mg-icon-scale')].join('|');
}

// One change can arrive twice (the attribute, then a cfd:appearance event): listeners run once,
// in a microtask, after both.
function appearanceChanged(): void {
  cache = new WeakMap();
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    cache = new WeakMap();
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.warn('[theme] an appearance listener failed', err);
      }
    }
  });
}

function watchAppearance(): void {
  if (watching) return;
  watching = true;
  lastKey = appearanceKey();
  new MutationObserver(() => {
    const key = appearanceKey();
    if (key === lastKey) return;
    lastKey = key;
    appearanceChanged();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  window.addEventListener('cfd:appearance', () => {
    lastKey = appearanceKey();
    appearanceChanged();
  });
}

/**
 * Runs `fn` after each appearance change: html's data-theme or its text and icon scales change, or
 * a cfd:appearance event. Theme colours read from then on are the new ones. Returns the unsubscribe.
 */
export function onAppearance(fn: () => void): () => void {
  watchAppearance();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
