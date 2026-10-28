// The tunnel's and the host's tokens, read from their stylesheets and resolved as an element of a
// theme has them (no browser resolves them in the unit tests): the host's light set, its dark set
// over it in dark, then the tunnel's own (declared again on any [data-theme] element).
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Theme = 'light' | 'dark';

/** A stylesheet's text with its comments taken out. */
export const readCss = (...parts: string[]) => readFileSync(join(__dirname, ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Each rule of a stylesheet: its selectors and its custom properties. */
export function rules(css: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()),
    props: Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()])) as Record<string, string>,
  }));
}

export const tunnel = rules(readCss('..', 'src', 'styles', 'tokens.css'));
export const host = rules(readCss('..', '..', '..', 'src', 'theme', 'tokens.css'));
export const hostLight = host.find((r) => r.selectors.includes('[data-theme="light"]'))!;
export const hostDark = host.find((r) => r.selectors.join() === '[data-theme="dark"]')!;
/** The tunnel's tokens, on the page and on any element with a theme of its own. */
export const tunnelBase = tunnel.find((r) => '--t2d-bg' in r.props)!;
/** The tunnel's dark values (none: an empty block). */
export const tunnelDark = tunnel.find((r) => r.selectors.join() === '[data-theme="dark"]') ?? { selectors: ['[data-theme="dark"]'], props: {} as Record<string, string> };

/** Every token an element of `theme` declares, as written. */
export function tokensOf(theme: Theme): Record<string, string> {
  return theme === 'dark' ? { ...hostLight.props, ...hostDark.props, ...tunnelBase.props, ...tunnelDark.props } : { ...hostLight.props, ...tunnelBase.props };
}

/** A token as an element of `theme` has it (var() resolved, trimmed), as getComputedStyle reads it; '' when none. */
export function tokenReader(theme: Theme): (name: string) => string {
  const props = tokensOf(theme);
  const resolve = (v: string, depth: number): string =>
    depth > 16 ? '' : v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) => resolve(props[name] ?? fallback ?? '', depth + 1));
  return (name) => resolve(props[name] ?? '', 0).trim();
}
