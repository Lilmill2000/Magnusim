// Helpers for the token and palette tests: CAD's token blocks (src/styles/tokens.css), the host's
// (magnusim-web/src/theme/tokens.css, light and dark), var() resolution and the WCAG contrast of
// flat colours.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The suite runs from the plugin's folder (jsdom's import.meta.url is no file URL).
export const PLUGIN = process.cwd();
export const CAD_TOKENS = join(PLUGIN, 'src/styles/tokens.css');
export const HOST_TOKENS = join(PLUGIN, '../../src/theme/tokens.css');

export type Tokens = Map<string, string>;

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every rule of a stylesheet: its selector (whitespace collapsed) and its custom properties in order. */
export function customPropertyRules(css: string): { selector: string; props: Tokens }[] {
  const out: { selector: string; props: Tokens }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const text = stripComments(css);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const props: Tokens = new Map();
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim();
      if (name.startsWith('--')) props.set(name, decl.slice(i + 1).trim());
    }
    out.push({ selector: m[1].replace(/\s+/g, ' ').trim(), props });
  }
  return out;
}

/** The light block (`:root` or `:root, [data-theme="light"]`) and the dark block of a token file. */
export function tokenBlocks(css: string): { light: Tokens; lightSelector: string | null; dark: Tokens | null } {
  const light: Tokens = new Map();
  let lightSelector: string | null = null;
  let dark: Tokens | null = null;
  for (const r of customPropertyRules(css)) {
    if (r.selector === ':root' || r.selector === ':root, [data-theme="light"]') {
      // The host also declares its scales on :root apart: the first block with colours names it.
      if (lightSelector === null && r.props.size > 2) lightSelector = r.selector;
      for (const [k, v] of r.props) light.set(k, v);
    } else if (r.selector === '[data-theme="dark"]') {
      dark = dark ?? new Map();
      for (const [k, v] of r.props) dark.set(k, v);
    }
  }
  return { light, lightSelector, dark };
}

export function cadTokens() {
  return tokenBlocks(readFileSync(CAD_TOKENS, 'utf8'));
}

/**
 * The host's tokens (its own src/theme/tokens.css, the file its /plugin-sdk/theme.css serves the
 * frame): the light set, and the dark set over it. The host has had its dark set since 10caf36b;
 * a host file without one is an error here, not a light pass.
 */
export function hostTokens(): { light: Tokens; dark: Tokens } {
  const own = tokenBlocks(readFileSync(HOST_TOKENS, 'utf8'));
  if (!own.dark) throw new Error(`${HOST_TOKENS} has no [data-theme="dark"] block`);
  return { light: own.light, dark: new Map([...own.light, ...own.dark]) };
}

/** A value with every var() replaced (its token's value, else its fallback); null when one has neither. */
export function resolveVars(value: string, lookup: (name: string) => string | undefined, depth = 0): string | null {
  if (depth > 10) return null;
  const at = value.indexOf('var(');
  if (at < 0) return value.trim();
  // The var( ... ) with its nested parentheses.
  let i = at + 4;
  let level = 1;
  for (; i < value.length && level > 0; i++) {
    if (value[i] === '(') level++;
    else if (value[i] === ')') level--;
  }
  const inner = value.slice(at + 4, i - 1);
  const comma = inner.indexOf(',');
  const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
  const own = lookup(name);
  const sub = own !== undefined ? resolveVars(own, lookup, depth + 1) : comma >= 0 ? resolveVars(inner.slice(comma + 1), lookup, depth + 1) : null;
  if (sub === null) return null;
  return resolveVars(value.slice(0, at) + sub + value.slice(i), lookup, depth + 1);
}

/** The theme's resolved value of a token (CAD's block for the theme, then CAD's light block, then the host's set). */
export function themeValue(name: string, theme: 'light' | 'dark'): string | null {
  const cad = cadTokens();
  const host = hostTokens();
  const lookup = (n: string): string | undefined => (theme === 'dark' ? (cad.dark?.get(n) ?? cad.light.get(n) ?? host.dark.get(n)) : (cad.light.get(n) ?? host.light.get(n)));
  return resolveVars(`var(${name})`, lookup);
}

export type Rgba = [number, number, number, number];

/** '#rgb', '#rrggbb', 'rgb()' or 'rgba()' -> [r, g, b, a] (0..255, a 0..1); null for anything else. */
export function parseColor(s: string): Rgba | null {
  const t = s.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return [...m[1].split('').map((c) => parseInt(c + c, 16)), 1] as Rgba;
  m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length >= 3 && p.every((x) => Number.isFinite(x))) return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return null;
}

/** A colour over an opaque one. */
export function over(top: Rgba, below: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + below[0] * (1 - a), top[1] * a + below[1] * (1 - a), top[2] * a + below[2] * (1 - a), 1];
}

export function hexOf(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function luminance(c: Rgba): number {
  const ch = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

/** WCAG contrast of two colours (a translucent one is laid over the other first). */
export function contrast(a: string | number, b: string | number): number {
  const pb = parseColor(typeof b === 'number' ? hexOf(b) : b);
  const pa0 = parseColor(typeof a === 'number' ? hexOf(a) : a);
  if (!pa0 || !pb) throw new Error(`not a colour: ${a} / ${b}`);
  const pa = pa0[3] < 1 ? over(pa0, pb) : pa0;
  const [hi, lo] = [luminance(pa), luminance(pb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
