/**
 * The app's look (Settings → Appearance): light, dark or the system's, a text size and an icon
 * size. The person's choice is in the app prefs (/api/prefs theme, text_scale, icon_scale; the
 * server keeps the same lists, scripts/prefs.js) and is shown on the page by applyAppearance:
 *
 *   html[data-theme]        the resolved theme, "light" or "dark" (tokens.css takes its set, and its
 *                           color-scheme: never inline, so a light swap on html for one task, as
 *                           domPicture's lightPage, has the browser's light controls too)
 *   html[data-theme-pref]   what the person chose: light, dark or system
 *   --mg-text-scale, --mg-icon-scale on html (tokens.css sizes text and icons by them)
 *
 * then the window event 'cfd:appearance' {theme, text_scale, icon_scale} (theme resolved), which the
 * 3D views and charts repaint on (themeColor.ts onAppearance), and which a plugin's workspace frame
 * hears (its bridge sends frameAppearance() as the SDK's `appearance` event). "system" follows the
 * system's light or dark as it changes. A change made here reaches this app's other tabs
 * (BroadcastChannel). The page's first paint has the look before any app script runs: the
 * pre-paint script in index.html and cad.html reads the one the server put on <html> (data-look,
 * scripts/prefs.js stampAppearance), else this origin's copy in localStorage (kept here); a
 * workspace page's own pre-paint does the same (scripts/server/workspace-files.ts). Nothing here
 * reads data-theme off any element but html (a capture puts one on .viewport-wrap for a moment).
 * Until the prefs answer, the look shown is the first paint's (html's data-theme-pref and scales,
 * read as this module loads, before any task could swap them).
 */
import type { Appearance as FrameAppearance } from '../plugin-sdk/workspace';

export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export interface Appearance {
  theme: ThemePref;
  text_scale: number;
  icon_scale: number;
}

/** What Settings offers (scripts/prefs.js keeps the same lists). */
export const THEMES: readonly ThemePref[] = ['light', 'dark', 'system'];
export const TEXT_SCALES: readonly number[] = [0.9, 1, 1.15, 1.3];
export const ICON_SCALES: readonly number[] = [0.85, 1, 1.25, 1.5];
export const DEFAULT_APPEARANCE: Readonly<Appearance> = Object.freeze({ theme: 'light', text_scale: 1, icon_scale: 1 });

/** The localStorage key the first paint reads (index.html, cad.html). */
export const APPEARANCE_KEY = 'magnusim.appearance';
/** This app's other tabs hear a change here. */
export const APPEARANCE_CHANNEL = 'magnusim-appearance';
/** The window event after each look shown (detail: theme resolved, text_scale, icon_scale). */
export const APPEARANCE_EVENT = 'cfd:appearance';

const DARK_QUERY = '(prefers-color-scheme: dark)';
/** This page, on the channel: it does not take back what it said. */
const ME = Math.random().toString(36).slice(2, 10);

/** The person's look in a prefs answer (or any value): each field one Settings offers, else its default. */
export function readAppearance(v: unknown): Appearance {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const pick = <T>(list: readonly T[], x: unknown, d: T): T => (list.includes(x as T) ? (x as T) : d);
  return {
    theme: pick(THEMES, o.theme, DEFAULT_APPEARANCE.theme),
    text_scale: pick(TEXT_SCALES, o.text_scale, DEFAULT_APPEARANCE.text_scale),
    icon_scale: pick(ICON_SCALES, o.icon_scale, DEFAULT_APPEARANCE.icon_scale),
  };
}

/** Whether the system asks for dark now. */
function systemDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** The theme a choice shows: light or dark ("system": the system's now). */
export function resolveTheme(pref: ThemePref, dark: boolean = systemDark()): Theme {
  if (pref === 'system') return dark ? 'dark' : 'light';
  return pref;
}

/** The look the first paint showed (the pre-paint script's choice and scales on html), else the default. */
function firstPaint(): Appearance {
  if (typeof document === 'undefined') return { ...DEFAULT_APPEARANCE };
  const html = document.documentElement;
  const scale = (name: string) => Number(html.style.getPropertyValue(name)) || undefined;
  return readAppearance({ theme: html.dataset.themePref, text_scale: scale('--mg-text-scale'), icon_scale: scale('--mg-icon-scale') });
}

let shown: Appearance = firstPaint();
let watching: MediaQueryList | null = null;

const onSystem = () => {
  if (shown.theme === 'system') show(shown);
};

/** "system" follows the system's light or dark as it changes (once a page). */
function watchSystem(): void {
  if (watching || typeof matchMedia !== 'function') return;
  try {
    watching = matchMedia(DARK_QUERY);
    watching.addEventListener('change', onSystem);
  } catch {
    watching = null;
  }
}

// A first paint of "system" follows it already, before the prefs answer.
if (shown.theme === 'system') watchSystem();

/** Puts a look on the page: html's attributes and scales, then 'cfd:appearance'. */
function show(a: Appearance): void {
  const html = document.documentElement;
  const theme = resolveTheme(a.theme);
  html.dataset.theme = theme;
  html.dataset.themePref = a.theme;
  html.style.setProperty('--mg-text-scale', String(a.text_scale));
  html.style.setProperty('--mg-icon-scale', String(a.icon_scale));
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: { theme, text_scale: a.text_scale, icon_scale: a.icon_scale } }));
}

/**
 * Shows the person's look on this page and keeps it for the next first paint. `announce`: tell this
 * app's other tabs too (a change made here; not one heard from them).
 */
export function applyAppearance(next: Appearance, opts: { announce?: boolean } = {}): void {
  shown = readAppearance(next);
  if (shown.theme === 'system') watchSystem();
  show(shown);
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(shown));
  } catch {
    /* the first paint has the light look until the prefs answer */
  }
  if (opts.announce && typeof BroadcastChannel !== 'undefined') {
    try {
      const ch = new BroadcastChannel(APPEARANCE_CHANNEL);
      ch.postMessage({ ...shown, from: ME });
      ch.close();
    } catch {
      /* the other tabs read it at their next start */
    }
  }
}

/** The look the page shows now (the person's choice, not resolved). */
export function currentAppearance(): Appearance {
  return { ...shown };
}

/** The theme the page shows now: light or dark. */
export function currentTheme(): Theme {
  return resolveTheme(shown.theme);
}

/**
 * The look as a plugin's workspace frame gets it (the bridge's welcome and `appearance` event): the
 * theme on screen, the person's choice, the sizes. Never read off html: a light swap of html for
 * one task (a picture) is not the look.
 */
export function frameAppearance(): FrameAppearance {
  return { theme: currentTheme(), preference: shown.theme, textScale: shown.text_scale, iconScale: shown.icon_scale };
}

let syncing: BroadcastChannel | null = null;

/** Shows a change made in this app's other tabs here too (once per page). Returns the stop. */
export function startAppearanceSync(): () => void {
  if (syncing || typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(APPEARANCE_CHANNEL);
  ch.onmessage = (e: MessageEvent) => {
    if (e.data && (e.data as { from?: unknown }).from === ME) return;
    applyAppearance(readAppearance(e.data));
  };
  syncing = ch;
  return () => {
    ch.close();
    if (syncing === ch) syncing = null;
  };
}

/**
 * Saves a change to the person's look (the app prefs) and shows it here and in the other tabs.
 * The look as saved, or the server's reason it was not.
 */
export async function saveAppearance(patch: Partial<Appearance>): Promise<{ ok: true; appearance: Appearance } | { ok: false; error: string }> {
  let r: Response;
  let j: Record<string, unknown>;
  try {
    r = await fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `Could not save the look: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!r.ok || j.ok === false || !j.prefs) return { ok: false, error: String(j.error || `Could not save the look: the app answered ${r.status}`) };
  // The page's copy of the prefs, as every other Settings save keeps it.
  (window as unknown as { __CFD_PREFS__?: unknown }).__CFD_PREFS__ = j.prefs;
  const saved = readAppearance(j.prefs);
  applyAppearance(saved, { announce: true });
  return { ok: true, appearance: saved };
}

/** For the tests: forget the look shown and stop following the system. */
export function resetAppearanceForTests(): void {
  shown = { ...DEFAULT_APPEARANCE };
  watching?.removeEventListener('change', onSystem);
  watching = null;
  syncing?.close();
  syncing = null;
}
